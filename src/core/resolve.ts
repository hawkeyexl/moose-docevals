/**
 * Resolution: merge a page's `moose-docevals` frontmatter with the central config
 * into a concrete per-page plan. Suites contribute named evals; page entries
 * reference them (with overrides) or define inline evals. Page entries win on
 * name collision.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import frontmatterSchema from "../../schemas/frontmatter-0.1.json" with { type: "json" };
import type { EvalType, GraderKind, Severity } from "../types.js";
import type { DocevalsConfig, EvalDef } from "./config.js";
import type { PageFile } from "./discover.js";

export interface ResolvedEval {
  name: string;
  /** Suite this eval reports under ("default" when none applies). */
  suite: string;
  assertion?: string;
  type: EvalType;
  grader: GraderKind;
  evidence?: string;
  examples?: { pass?: string; fail?: string };
  command?: string[];
  successExitCodes: number[];
  timeoutMs?: number;
  generated?: { assertionHash: string };
  options: Record<string, unknown>;
  severity: Severity;
  severityMap?: Record<string, Severity>;
  /** Where the eval definition came from. */
  source: "config" | "page";
  skip: boolean;
}

export interface PageProblem {
  message: string;
  level: "error" | "warning";
  line?: number;
}

export interface ResolvedPagePlan {
  page: PageFile;
  /** Page-level skip (moose-docevals.skip: true). */
  skip: boolean;
  suite: string | null;
  generatedBy?: string;
  evals: ResolvedEval[];
  problems: PageProblem[];
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const validateFrontmatter = ajv.compile(frontmatterSchema);

interface FrontmatterEvalRef {
  use: string;
  type?: EvalType;
  skip?: boolean;
  severity?: Severity;
  options?: Record<string, unknown>;
}

type FrontmatterEvalEntry = string | FrontmatterEvalRef | (EvalDef & { name: string; skip?: boolean });

interface EvalsKey {
  suite?: string;
  skip?: boolean;
  generatedBy?: string;
  evals?: FrontmatterEvalEntry[];
}

/**
 * The `evals` frontmatter key accepts an array (just the eval list) or an
 * object ({suite, skip, generatedBy, evals}). Normalize to the object form,
 * and report the JSON-Pointer prefix under which eval entries live so
 * problems map to the right source lines.
 */
function normalizeEvalsKey(raw: unknown): { fm: EvalsKey; entriesPtr: string } {
  if (Array.isArray(raw)) {
    return { fm: { evals: raw as FrontmatterEvalEntry[] }, entriesPtr: "/evals" };
  }
  return { fm: (raw ?? {}) as EvalsKey, entriesPtr: "/evals/evals" };
}

function fromDef(
  name: string,
  suite: string,
  def: EvalDef,
  source: "config" | "page",
): ResolvedEval {
  return {
    name,
    suite,
    assertion: def.assertion,
    type: def.type ?? "regression",
    grader: (def.grader ?? "llm") as GraderKind,
    evidence: def.evidence,
    examples: def.examples,
    command: def.command,
    successExitCodes: def.successExitCodes ?? [0],
    timeoutMs: def.timeoutMs,
    generated: def.generated,
    options: def.options ?? {},
    severity: def.severity ?? "error",
    severityMap: def.severityMap,
    source,
    skip: false,
  };
}

/** Resolve one page's plan. Never throws; problems are collected per page. */
export function resolvePage(
  page: PageFile,
  config: DocevalsConfig,
): ResolvedPagePlan {
  const problems: PageProblem[] = [];
  if (page.extractError) {
    problems.push({ message: page.extractError, level: "error", line: 1 });
    return { page, skip: false, suite: null, evals: [], problems };
  }

  const data = page.frontmatter.data;
  // Validate only the evals key shape; other frontmatter is out of scope here.
  if ("evals" in data && !validateFrontmatter({ evals: data.evals })) {
    for (const e of validateFrontmatter.errors ?? []) {
      problems.push({
        message: `frontmatter${e.instancePath}: ${e.message}`,
        level: "error",
        line: page.frontmatter.lineFor(e.instancePath) ?? 1,
      });
    }
    return { page, skip: false, suite: null, evals: [], problems };
  }

  const { fm, entriesPtr } = normalizeEvalsKey(data.evals);
  const suiteName = fm.suite ?? config.defaults.suite;
  if (fm.suite && !(fm.suite in config.suites)) {
    problems.push({
      message: `Unknown suite "${fm.suite}" (not defined in ${config.configPath})`,
      level: "error",
      line: page.frontmatter.lineFor("/evals/suite") ?? 1,
    });
    return { page, skip: fm.skip ?? false, suite: null, evals: [], problems };
  }

  const resolved = new Map<string, ResolvedEval>();

  // 1. Suite evals from the central config.
  if (suiteName) {
    const suite = config.suites[suiteName];
    for (const name of suite?.evals ?? []) {
      const def = config.evals[name];
      if (def) resolved.set(name, fromDef(name, suiteName, def, "config"));
    }
  }

  // 2. Page entries: references (with overrides) and inline evals.
  const reportSuite = suiteName ?? "default";
  for (const [i, entry] of (fm.evals ?? []).entries()) {
    const linePtr = `${entriesPtr}/${i}`;
    if (typeof entry === "string" || "use" in entry) {
      const ref: FrontmatterEvalRef =
        typeof entry === "string" ? { use: entry } : entry;
      const def = config.evals[ref.use];
      if (!def) {
        problems.push({
          message: `Unknown eval "${ref.use}" (not defined in ${config.configPath})`,
          level: "error",
          line: page.frontmatter.lineFor(linePtr) ?? 1,
        });
        continue;
      }
      const base =
        resolved.get(ref.use) ?? fromDef(ref.use, reportSuite, def, "config");
      resolved.set(ref.use, {
        ...base,
        type: ref.type ?? base.type,
        severity: ref.severity ?? base.severity,
        options: { ...base.options, ...(ref.options ?? {}) },
        skip: ref.skip ?? base.skip,
      });
    } else {
      const inline = entry;
      if (resolved.has(inline.name)) {
        problems.push({
          message: `Duplicate eval name "${inline.name}" on page`,
          level: "warning",
          line: page.frontmatter.lineFor(linePtr) ?? 1,
        });
      }
      const ev = fromDef(inline.name, reportSuite, inline, "page");
      ev.skip = inline.skip ?? false;
      resolved.set(inline.name, ev);
      if (ev.grader === "llm" && !inline.examples) {
        problems.push({
          message: `Eval "${inline.name}": llm-graded evals work best with examples.pass/examples.fail`,
          level: "warning",
          line: page.frontmatter.lineFor(linePtr) ?? 1,
        });
      }
    }
  }

  return {
    page,
    skip: fm.skip ?? false,
    suite: suiteName,
    generatedBy: fm.generatedBy,
    evals: [...resolved.values()],
    problems,
  };
}

/** Resolve all pages. */
export function resolvePages(
  pages: PageFile[],
  config: DocevalsConfig,
): ResolvedPagePlan[] {
  return pages.map((p) => resolvePage(p, config));
}
