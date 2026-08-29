/**
 * `moose-docevals calibrate` — measure judge agreement against a human-verified
 * golden set (the book's step 3: calibrate judges before trusting them).
 * Golden cases live in YAML files under .moose-docevals/golden/ by default:
 *
 *   - file: docs/install.md
 *     eval: no-future-promises      # ai-graded eval resolvable on that page
 *     expected: pass
 *     rationale: Mentions only shipped features.
 *
 * Below 70% agreement the command exits 1 — the criteria (usually) need to be
 * more specific, not the grading mechanism. A false-positive rate above
 * judge.falsePositiveAlert flags retuning.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import pc from "picocolors";
import { DocevalsError } from "../types.js";
import { loadConfig } from "../core/config.js";
import { readPage } from "../core/discover.js";
import { resolvePage } from "../core/resolve.js";
import { makeJudge } from "../judge/judge.js";
import { makeProvider } from "../judge/provider.js";
import type { JudgeFn } from "../core/engine.js";

export const AGREEMENT_THRESHOLD = 0.7;

export interface GoldenCase {
  file: string;
  eval: string;
  expected: "pass" | "fail";
  rationale?: string;
}

export interface CalibrationCaseResult extends GoldenCase {
  judged?: "pass" | "fail";
  agrees?: boolean;
  error?: string;
}

export interface CalibrationReport {
  cases: CalibrationCaseResult[];
  total: number;
  agreements: number;
  agreementRate: number;
  falsePositives: number;
  falsePositiveRate: number;
  falseNegatives: number;
  meetsThreshold: boolean;
  fpAlert: boolean;
}

export interface CalibrateOptions {
  config?: string;
  golden?: string;
  provider?: string;
  model?: string;
  runs?: number;
  noCache?: boolean;
  cwd?: string;
  /** Injectable judge for tests. */
  judge?: JudgeFn;
}

export function loadGoldenCases(dir: string): GoldenCase[] {
  if (!existsSync(dir)) {
    throw new DocevalsError(
      `Golden set directory not found: ${dir} — create it with 20-50 human-verified cases`,
    );
  }
  const files = fg.sync("*.{yaml,yml}", { cwd: dir, absolute: true });
  const cases: GoldenCase[] = [];
  for (const file of files) {
    const raw = parseYaml(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const c = item as Partial<GoldenCase>;
      if (
        typeof c.file === "string" &&
        typeof c.eval === "string" &&
        (c.expected === "pass" || c.expected === "fail")
      ) {
        cases.push(c as GoldenCase);
      } else {
        throw new DocevalsError(
          `Invalid golden case in ${file}: needs file, eval, expected: pass|fail`,
        );
      }
    }
  }
  if (cases.length === 0) {
    throw new DocevalsError(`No golden cases found in ${dir}`);
  }
  return cases;
}

export async function runCalibrate(
  options: CalibrateOptions = {},
): Promise<CalibrationReport> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(options.config, cwd);
  const goldenDir = resolve(cwd, options.golden ?? join(".moose-docevals", "golden"));
  const cases = loadGoldenCases(goldenDir);

  const judge =
    options.judge ??
    makeJudge({
      provider: makeProvider(config, {
        provider: options.provider,
        model: options.model,
      }),
      root: cwd,
    });

  const results: CalibrationCaseResult[] = [];
  for (const goldenCase of cases) {
    const absPath = resolve(cwd, goldenCase.file);
    if (!existsSync(absPath)) {
      results.push({ ...goldenCase, error: "page not found" });
      continue;
    }
    const page = readPage(absPath, cwd);
    const plan = resolvePage(page, config);
    const ev = plan.evals.find(
      (e) => e.name === goldenCase.eval && e.grader === "ai",
    );
    if (!ev) {
      results.push({
        ...goldenCase,
        error: `ai-graded eval "${goldenCase.eval}" not resolvable on this page`,
      });
      continue;
    }
    const [result] = await judge([{ plan, eval: ev }], config, {
      runs: options.runs,
      noCache: options.noCache,
    });
    if (!result?.consensus) {
      results.push({ ...goldenCase, error: "judge returned no consensus" });
      continue;
    }
    const judged = result.consensus.verdict === "pass" ? "pass" : "fail";
    results.push({
      ...goldenCase,
      judged,
      agrees: judged === goldenCase.expected,
    });
  }

  const judgedCases = results.filter((r) => r.judged != null);
  const agreements = judgedCases.filter((r) => r.agrees).length;
  const expectedPass = judgedCases.filter((r) => r.expected === "pass");
  // False positive: the judge flags a failure a human verified as passing.
  const falsePositives = expectedPass.filter((r) => r.judged === "fail").length;
  const falseNegatives = judgedCases.filter(
    (r) => r.expected === "fail" && r.judged === "pass",
  ).length;
  const agreementRate = judgedCases.length > 0 ? agreements / judgedCases.length : 0;
  const falsePositiveRate =
    expectedPass.length > 0 ? falsePositives / expectedPass.length : 0;

  return {
    cases: results,
    total: results.length,
    agreements,
    agreementRate,
    falsePositives,
    falsePositiveRate,
    falseNegatives,
    meetsThreshold: agreementRate >= AGREEMENT_THRESHOLD,
    fpAlert: falsePositiveRate > config.judge.falsePositiveAlert,
  };
}

export function renderCalibration(report: CalibrationReport): string {
  const lines: string[] = [];
  for (const c of report.cases) {
    if (c.error) {
      lines.push(`${pc.red("error")} ${c.file} ${c.eval}: ${c.error}`);
      continue;
    }
    const tag = c.agrees ? pc.green("agree") : pc.red("DISAGREE");
    lines.push(
      `${tag} ${c.file} ${pc.bold(c.eval)}: judge=${c.judged ?? "(no verdict)"} human=${c.expected}` +
        (!c.agrees && c.rationale ? pc.dim(` — human: ${c.rationale}`) : ""),
    );
  }
  lines.push("");
  lines.push(
    `Agreement: ${report.agreements}/${report.total} (${(report.agreementRate * 100).toFixed(0)}%) — threshold ${(AGREEMENT_THRESHOLD * 100).toFixed(0)}%`,
  );
  lines.push(
    `False positives: ${report.falsePositives} (${(report.falsePositiveRate * 100).toFixed(0)}% of human-passes), false negatives: ${report.falseNegatives}`,
  );
  if (!report.meetsThreshold) {
    lines.push(
      pc.red(
        "\nAgreement is below threshold. Refine the eval criteria first — make assertions more specific — before changing the grading mechanism.",
      ),
    );
  }
  if (report.fpAlert) {
    lines.push(
      pc.yellow(
        "\nFalse-positive rate exceeds judge.falsePositiveAlert — the judge is flagging content humans accept. Consider tightening assertions or examples.",
      ),
    );
  }
  return lines.join("\n");
}
