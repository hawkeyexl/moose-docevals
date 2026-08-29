/**
 * `moose-docevals fill` — ask an LLM provider to propose frontmatter evals for each
 * page, gate the proposals on self-reported confidence, and append the
 * survivors to the page's frontmatter. Proposals are ai-graded only and
 * deduplicated against the page's resolved plan; existing evals are never
 * touched. See ADR 01001.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { loadConfig } from "../core/config.js";
import { discoverPages, leadingFrontmatterFormat } from "../core/discover.js";
import { resolvePages, type ResolvedPagePlan } from "../core/resolve.js";
import { appendPageEvals, type NewEvalEntry } from "../core/frontmatter-edit.js";
import {
  parseFormat,
  SUMMARY_FORMATS,
  type SummaryFormat,
} from "../reporters/format.js";
import { makeProvider, resolveProviderIdentity } from "../judge/provider.js";
import type { InferenceProvider } from "@hawkeyexl/inference";
import { FillCache, fillCacheKey } from "../fill/cache.js";
import {
  FILL_SYSTEM_PROMPT,
  buildFillUser,
  isValidProposal,
  PROPOSAL_SCHEMA,
} from "../fill/prompt.js";

export interface FillOptions {
  config?: string;
  cwd?: string;
  /** Report proposals without writing frontmatter. */
  dryRun?: boolean;
  /** Minimum confidence to write; overrides config `fill.confidenceThreshold`. */
  confidence?: number;
  /** Stop after this many inference calls; overrides config `fill.maxTurns`. */
  maxTurns?: number;
  noCache?: boolean;
  provider?: string;
  model?: string;
  /** Test seam: bypasses provider construction entirely. */
  providerInstance?: InferenceProvider;
}

export type FillStatus =
  | "filled"
  | "proposed"
  | "nothing-proposed"
  | "skipped"
  | "skipped-budget"
  | "error";

export interface ProposedEval {
  id: string;
  assertion: string;
  confidence: number;
  examples: { pass: string; fail: string };
  type?: "capability" | "regression";
  evidence?: string;
  severity?: "error" | "warning" | "info";
  rationale?: string;
}

export interface FillPageResult {
  file: string;
  status: FillStatus;
  /** Appended (or, in a dry run, would-append) proposals. */
  written: ProposedEval[];
  /** Proposals below the confidence threshold — reported, never written. */
  belowThreshold: ProposedEval[];
  /** Fresh proposals dropped for exceeding `fill.maxEvalsPerPage`. */
  capped: ProposedEval[];
  /** Proposed ids that already exist in the page's resolved plan. */
  duplicates: string[];
  cached: boolean;
  error?: string;
}

export interface FillReport {
  results: FillPageResult[];
  threshold: number;
  /** Inference calls actually made. One per proposed page; a cache hit is none. */
  turns: number;
  exitCode: 0 | 1;
}

/**
 * Proposals become inline evals with explicit grader/type. Confidence is no
 * longer report-only — it is written to `eval-provenance` alongside the model
 * that proposed it, so the page itself records what a machine wrote and how
 * sure it was, and a reviewer retires the entry when they have checked it.
 */
function toEntry(p: ProposedEval): NewEvalEntry {
  return {
    id: p.id,
    assertion: p.assertion,
    type: p.type ?? "regression",
    grader: "ai",
    evidence: p.evidence,
    examples: p.examples,
    severity: p.severity,
  };
}

export async function runFill(
  globs: string[],
  options: FillOptions = {},
): Promise<FillReport> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(options.config, cwd);
  const pages = discoverPages(config, globs, cwd);
  const plans = resolvePages(pages, config);

  const threshold = options.confidence ?? config.fill.confidenceThreshold;
  const maxTurns = options.maxTurns ?? config.fill.maxTurns;
  const temperature = config.fill.temperature;
  const maxEvals = config.fill.maxEvalsPerPage;
  const cache = new FillCache(
    resolve(cwd, config.fill.cacheDir),
    !options.noCache,
  );

  // Identity is resolved without constructing the provider, so fully-cached
  // or all-skipped runs need no API key.
  let provider = options.providerInstance;
  const identity = provider
    ? { provider: provider.provider(), model: provider.modelName() }
    : resolveProviderIdentity(config, {
        provider: options.provider,
        model: options.model,
      });
  const getProvider = () =>
    (provider ??= makeProvider(config, {
      provider: options.provider,
      model: options.model,
    }));
  let turns = 0;
  const results: FillPageResult[] = [];

  for (const plan of plans) {
    results.push(await fillOne(plan));
  }

  return {
    results,
    threshold,
    turns,
    exitCode: results.some((r) => r.status === "error") ? 1 : 0,
  };

  async function fillOne(plan: ResolvedPagePlan): Promise<FillPageResult> {
    const base: FillPageResult = {
      file: plan.page.file,
      status: "nothing-proposed",
      written: [],
      belowThreshold: [],
      capped: [],
      duplicates: [],
      cached: false,
    };
    if (plan.skip) return { ...base, status: "skipped" };
    const problem = plan.problems.find((p) => p.level === "error");
    if (problem) return { ...base, status: "error", error: problem.message };
    // Reject non-YAML frontmatter before spending an LLM call: it can't be
    // appended to (appendPageEvals would otherwise refuse) and there is
    // nothing to fill.
    const format = leadingFrontmatterFormat(plan.page.content);
    if (format === "toml" || format === "json") {
      return {
        ...base,
        status: "error",
        error: `only YAML frontmatter can be filled (found ${format} frontmatter)`,
      };
    }

    const existing = plan.evals.map((e) => ({
      id: e.name,
      assertion: e.assertion,
    }));
    const existingNames = existing.map((e) => e.id).sort();
    const key = fillCacheKey(
      identity.provider,
      identity.model,
      temperature,
      maxEvals,
      plan.page.body,
      existingNames,
    );

    let raw = cache.get(key);
    const cached = raw !== undefined;
    if (!raw) {
      // Claimed before the call, not tallied after it (ADR 01019). A cache
      // hit never reaches here, so replaying a cached corpus spends no turns.
      if (maxTurns !== null && turns >= maxTurns) {
        return { ...base, status: "skipped-budget" };
      }
      turns += 1;
      try {
        const response = await getProvider().completeJSON({
          system: FILL_SYSTEM_PROMPT,
          user: buildFillUser(plan.page.file, plan.page.body, existing, maxEvals),
          schema: PROPOSAL_SCHEMA,
          temperature,
        });
        if (!isValidProposal(response.json)) {
          return {
            ...base,
            status: "error",
            error: "provider returned a proposal that does not match the schema",
          };
        }
        raw = response.json as Record<string, unknown>;
        cache.set(key, raw);
      } catch (e) {
        return {
          ...base,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    // Drop duplicates (against the resolved plan and within the batch) before
    // applying the per-page cap, so duplicate names never crowd out fresh
    // proposals.
    const seen = new Set(existingNames);
    const duplicates: string[] = [];
    const fresh: ProposedEval[] = [];
    for (const p of raw.evals as ProposedEval[]) {
      if (seen.has(p.id)) {
        duplicates.push(p.id);
        continue;
      }
      seen.add(p.id);
      fresh.push(p);
    }
    // Proposals beyond the per-page cap are reported as `capped` rather than
    // silently dropped — they may be high-confidence, so folding them into
    // belowThreshold would misreport why they weren't written.
    const capped = fresh.slice(maxEvals);
    const belowThreshold: ProposedEval[] = [];
    const written: ProposedEval[] = [];
    for (const p of fresh.slice(0, maxEvals)) {
      if (p.confidence >= threshold) written.push(p);
      else belowThreshold.push(p);
    }

    const result = {
      ...base,
      written,
      belowThreshold,
      capped,
      duplicates,
      cached,
    };
    if (written.length === 0) return result;
    try {
      const updated = appendPageEvals(
        plan.page.content,
        plan.page.file,
        written.map(toEntry),
        {
          generatedBy: identity.model,
          evals: written.map((p) => p.id),
          confidence: Object.fromEntries(
            written.map((p) => [p.id, p.confidence]),
          ),
        },
      );
      if (!options.dryRun) writeFileSync(plan.page.absPath, updated);
    } catch (e) {
      return {
        ...result,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        written: [],
      };
    }
    return { ...result, status: options.dryRun ? "proposed" : "filled" };
  }
}

const STATUS_LABELS: Record<FillStatus, string> = {
  filled: "filled",
  proposed: "proposed",
  "nothing-proposed": "no-op",
  skipped: "skipped",
  "skipped-budget": "skipped",
  error: "error",
};

export function renderFill(
  report: FillReport,
  format: SummaryFormat,
): string {
  // See renderList — same reasoning, same public exposure via src/index.ts.
  parseFormat(format, SUMMARY_FORMATS, "format");
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines: string[] = [];
  const names = (evals: ProposedEval[]) =>
    evals.map((p) => `${p.id} ${p.confidence.toFixed(2)}`).join(", ");
  for (const r of report.results) {
    const label = STATUS_LABELS[r.status].padEnd(8);
    const cachedTag = r.cached ? " [cached]" : "";
    switch (r.status) {
      case "filled":
        lines.push(
          `${pc.green(label)} ${r.file}  +${r.written.length} evals (${names(r.written)})${cachedTag}`,
        );
        break;
      case "proposed":
        lines.push(
          `${pc.cyan(label)} ${r.file}  +${r.written.length} evals (${names(r.written)})${cachedTag} — dry run, not written`,
        );
        break;
      case "nothing-proposed":
        lines.push(`${pc.dim(label)} ${r.file}  (nothing new proposed)${cachedTag}`);
        break;
      case "skipped":
        lines.push(`${pc.dim(label)} ${r.file}  (evals.skip)`);
        break;
      case "skipped-budget":
        lines.push(`${pc.yellow(label)} ${r.file}  (turn budget exhausted)`);
        break;
      case "error":
        lines.push(`${pc.red(label)} ${r.file}: ${r.error ?? "unknown error"}`);
        break;
    }
    if (r.belowThreshold.length > 0) {
      lines.push(
        pc.dim(
          `         below ${report.threshold}: ${names(r.belowThreshold)}`,
        ),
      );
    }
    if (r.capped.length > 0) {
      lines.push(
        pc.dim(`         over per-page cap: ${names(r.capped)}`),
      );
    }
    if (r.duplicates.length > 0) {
      lines.push(pc.dim(`         duplicates: ${r.duplicates.join(", ")}`));
    }
  }
  lines.push("");
  lines.push(
    `Threshold: ${report.threshold} · inference calls: ${report.turns}`,
  );
  return lines.join("\n");
}
