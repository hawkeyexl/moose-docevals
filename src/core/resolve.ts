/**
 * Resolution: merge a page's eval frontmatter with the central config into a
 * concrete per-page plan. Suites contribute named evals; page entries reference
 * them (with overrides) or define inline evals. Page entries win on id
 * collision.
 *
 * The page vocabulary is `docmeta:evals:1.0.0-proposal.2` — four flat
 * page-level keys (`evals`, `eval-suite`, `eval-skip`, `eval-provenance`) and a
 * reserved `eval-` prefix, rather than the closed `evals:` object 0.1 used. The
 * whole frontmatter object is validated, not a synthetic `{evals}`: the prefix
 * reservation is a claim about the page root, and it cannot be enforced from a
 * fragment.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
// Pages validate against the current schema, not the oldest one still shipped:
// 1.1.0 adds `weight`, `target`, `runs` and `model`, and 1.2.0 adds `cites`
// and `cite-commit`; validating against an older version would reject every
// page that uses them. The older versions stay published and byte-frozen for
// consumers who pinned them; every page valid against one is valid against
// this.
import frontmatterSchema from "../../schemas/frontmatter-1.2.0.json" with { type: "json" };
import type { EvalType, GraderKind, Severity } from "../types.js";
import {
  normalizeEvalDef,
  type DocevalsConfig,
  type EvalDef,
  type RawEvalDef,
} from "./config.js";
import type { PageFile } from "./discover.js";
import type { EvalTarget } from "./target.js";
import { scanCiteComments } from "../citations/comments.js";
import { parseSrc } from "../citations/hash.js";
import {
  noCitations,
  type Citation,
  type CitationAnchor,
  type PageCitations,
} from "../citations/types.js";

export interface ResolvedEval {
  /** Kebab-case id, unique per page. */
  name: string;
  /** Suite this eval reports under ("default" when none applies). */
  suite: string;
  assertion?: string;
  type: EvalType;
  grader: GraderKind;
  /** Per-eval provider/agent override for `ai` evals. */
  provider?: string;
  evidence?: string;
  examples?: { pass?: string[]; fail?: string[] };
  command?: string[];
  successExitCodes: number[];
  timeoutMs?: number;
  generatedAssertionHash?: string;
  options: Record<string, unknown>;
  severity: Severity;
  severityMap?: Record<string, Severity>;
  /**
   * Relative contribution to its suite's pass rate. Defaults to 1, which is
   * what makes weighting inert until someone asks for it: a suite of
   * unweighted evals computes exactly the rate it always did.
   */
  weight: number;
  /** Which bytes the grader receives. Absent means the page body. */
  target?: EvalTarget;
  /** Judge model for this eval; a CLI --model still wins. */
  model?: string;
  /** Ensemble runs for this eval; a CLI --runs still wins. */
  runs?: number;
  /** Where the eval definition came from. */
  source: "config" | "page";
  skip: boolean;
}

export interface PageProblem {
  message: string;
  level: "error" | "warning";
  line?: number;
}

/** One model's claim about evals it proposed, and how sure it was. */
export interface EvalProvenance {
  generatedBy: string;
  evals?: string[];
  confidence?: Record<string, number>;
}

export interface ResolvedPagePlan {
  page: PageFile;
  /** Page-level skip (`eval-skip: true`). */
  skip: boolean;
  suite: string | null;
  /**
   * Model that generated this page's content, read from the page's top-level
   * `generated-by` (docmeta:ai-context). The judge warns when it matches the
   * judging model — self-preference bias.
   */
  generatedBy?: string;
  /** Unretired machine-proposal trail from `eval-provenance`. */
  provenance: EvalProvenance[];
  evals: ResolvedEval[];
  /**
   * Every citation on the page, from the `cites` list and from inline body
   * comments alike, in one shape (ADR 01045).
   */
  citations: PageCitations;
  problems: PageProblem[];
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const validateFrontmatter = ajv.compile(frontmatterSchema);
// The same definition the `cites` list validates against, so an inline
// comment's entry is held to exactly the frontmatter entry's rules. Compiling
// the page schema registered its `$id`, which is what makes the ref resolve.
const validateCitationEntry = ((): ValidateFunction => {
  const fn = ajv.getSchema(
    `${(frontmatterSchema as { $id: string }).$id}#/$defs/citationEntry`,
  );
  if (fn === undefined) throw new Error("frontmatter schema has no $defs/citationEntry");
  return fn;
})();

interface FrontmatterEvalRef {
  use: string;
  type?: EvalType;
  skip?: boolean;
  severity?: Severity;
  /**
   * How much this check counts *for this page*. The reference form is how
   * most pages join a suite at all, so a weight the schema accepts and the
   * merge drops would score the page at the corpus default without saying so.
   */
  weight?: number;
  options?: Record<string, unknown>;
}

type FrontmatterEvalEntry =
  | string
  | FrontmatterEvalRef
  | (RawEvalDef & { id: string; skip?: boolean });

interface RawProvenanceEntry {
  "generated-by": string;
  evals?: string[];
  confidence?: Record<string, number>;
}

/** One `cites` entry as the schema admits it. */
interface RawCitationEntry {
  id?: string;
  src: string;
  sha256?: string;
  commit?: string;
  quote?: boolean;
}

/** The six page keys this vocabulary claims, plus the one it borrows. */
interface EvalFrontmatter {
  evals?: string | FrontmatterEvalEntry[];
  "eval-suite"?: string;
  "eval-skip"?: boolean;
  "eval-provenance"?: RawProvenanceEntry[];
  cites?: RawCitationEntry[];
  "cite-commit"?: string;
  "generated-by"?: string;
}

/**
 * `evals` is one assertion string or a list of entries. Normalize to the list;
 * a bare string is an ai-judged assertion at error severity, and it has no id
 * of its own — the string shorthand is the legitimately id-less form.
 */
function evalEntries(raw: EvalFrontmatter["evals"]): FrontmatterEvalEntry[] {
  if (raw === undefined) return [];
  return typeof raw === "string" ? [raw] : raw;
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
    grader: (def.grader ?? "ai") as GraderKind,
    provider: def.provider,
    evidence: def.evidence,
    examples: def.examples,
    command: def.command,
    successExitCodes: def.successExitCodes ?? [0],
    timeoutMs: def.timeoutMs,
    generatedAssertionHash: def.generatedAssertionHash,
    options: def.options ?? {},
    severity: def.severity ?? "error",
    severityMap: def.severityMap,
    weight: def.weight ?? 1,
    target: def.target,
    model: def.model,
    runs: def.runs,
    source,
    skip: false,
  };
}

/**
 * A name for a string-shorthand eval, derived from its position.
 *
 * Position-derived names orphan cached verdicts when entries move, which is
 * why object entries must carry an explicit `id`. The shorthand has no id by
 * design, so it accepts that cost in exchange for being one line.
 *
 * `taken` is every name already claimed on this page. Without it a derived
 * name can collide with an explicit `id` of the same spelling, and the Map
 * write silently drops one of two evals the author declared — a page checking
 * less than it says while the run stays green.
 */
function shorthandName(index: number, taken: ReadonlySet<string>): string {
  const base = `assertion-${index + 1}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The page-level keys this vocabulary claims, for the reservation messages. */
const RESERVED_KEYS = ["eval-suite", "eval-skip", "eval-provenance"] as const;
const RESERVED_CITE_KEYS = ["cite-commit"] as const;

/**
 * A schema error, in words.
 *
 * The `eval-` and `cite-` prefix reservations are expressed as
 * `patternProperties` entries whose subschema is `false`, and Ajv reports
 * that as "boolean schema is false" — which names neither the key nor the
 * fix. The reservation exists precisely to make a typo loud, so it gets a
 * sentence rather than Ajv's internals. An unknown property is named for the
 * same reason: "must NOT have additional properties" points at the parent.
 */
function describeError(e: ErrorObject): string {
  if (e.keyword === "false schema" && e.instancePath.startsWith("/eval-")) {
    const key = e.instancePath.slice(1);
    return (
      `unknown key "${key}". The "eval-" prefix is reserved, and the only ` +
      `settings under it are ${RESERVED_KEYS.join(", ")} — so a typo is an ` +
      `error here rather than a key nothing reads.`
    );
  }
  if (e.keyword === "false schema" && e.instancePath.startsWith("/cite-")) {
    const key = e.instancePath.slice(1);
    return (
      `unknown key "${key}". The "cite-" prefix is reserved, and the only ` +
      `setting under it is ${RESERVED_CITE_KEYS.join(", ")} — so a typo is an ` +
      `error here rather than a key nothing reads.`
    );
  }
  if (e.keyword === "additionalProperties") {
    const extra = (e.params as { additionalProperty?: string }).additionalProperty;
    if (extra !== undefined) return `unknown field "${extra}"`;
  }
  // About one short sha in 27 is all digits, and YAML reads an unquoted one as
  // an integer. "must be string" is true and useless; name the fix.
  if (
    e.keyword === "type" &&
    (e.params as { type?: string }).type === "string" &&
    /(^\/cite-commit$|\/commit$|\/sha256$)/.test(e.instancePath)
  ) {
    return "must be a string — an all-digit value is read by YAML as a number, so quote it";
  }
  return e.message ?? "is invalid";
}

/**
 * Both citation forms, normalized into one list.
 *
 * Frontmatter entries first, in list order, then inline comments in file
 * order. Reference comments attach to whichever entry carries their id, from
 * either form; one that names nothing is an orphan for the grader to report.
 * Every problem found here is an error: a citation the page cannot express
 * is a citation that checks nothing.
 */
function resolveCitations(
  page: PageFile,
  fm: EvalFrontmatter,
  problems: PageProblem[],
): PageCitations {
  const entries: Citation[] = [];
  const byId = new Map<string, Citation>();
  const defaultCommit = fm["cite-commit"];

  const claim = (c: Citation, line: number): void => {
    if (byId.has(c.id)) {
      problems.push({
        message:
          `Duplicate citation id "${c.id}" — a reference comment could name either, ` +
          `so the page must give each citation its own id`,
        level: "error",
        line,
      });
      return;
    }
    byId.set(c.id, c);
    entries.push(c);
  };

  for (const [i, raw] of (fm.cites ?? []).entries()) {
    const line = page.frontmatter.lineFor(`/cites/${i}`) ?? 1;
    const parsed = parseSrc(raw.src);
    if (!parsed.ok) {
      problems.push({
        message: `cites[${i}] "${raw.id ?? "?"}": src "${raw.src}" — ${parsed.error}`,
        level: "error",
        line: page.frontmatter.lineFor(`/cites/${i}/src`) ?? line,
      });
      continue;
    }
    const c: Citation = {
      // The schema requires `id` on a frontmatter entry; the fallback only
      // keeps the type honest.
      id: raw.id ?? `cites-${i}`,
      src: raw.src,
      spec: parsed.spec,
      quote: raw.quote ?? false,
      origin: "frontmatter",
      line,
      index: i,
      anchors: [],
    };
    if (raw.sha256 !== undefined) c.sha256 = raw.sha256;
    const commit = raw.commit ?? defaultCommit;
    if (commit !== undefined) c.commit = commit;
    claim(c, line);
  }

  const references: { id: string; anchor: CitationAnchor }[] = [];
  for (const comment of scanCiteComments(page.content)) {
    const where = `cite comment at line ${comment.line}`;
    if (comment.kind === "invalid") {
      problems.push({ message: `${where}: ${comment.reason}`, level: "error", line: comment.line });
      continue;
    }
    const anchor: CitationAnchor = {
      line: comment.line,
      claim: comment.claim,
      claimLine: comment.claimLine,
    };
    if (comment.kind === "reference") {
      references.push({ id: comment.id, anchor });
      continue;
    }
    if (!validateCitationEntry(comment.entry)) {
      for (const e of validateCitationEntry.errors ?? []) {
        const at = e.instancePath === "" ? "" : ` ${e.instancePath.slice(1)}`;
        problems.push({
          message: `${where}:${at} ${describeError(e)}`,
          level: "error",
          line: comment.line,
        });
      }
      continue;
    }
    const raw = comment.entry as unknown as RawCitationEntry;
    const parsed = parseSrc(raw.src);
    if (!parsed.ok) {
      problems.push({
        message: `${where}: src "${raw.src}" — ${parsed.error}`,
        level: "error",
        line: comment.line,
      });
      continue;
    }
    const c: Citation = {
      id: raw.id ?? `inline-${comment.line}`,
      src: raw.src,
      spec: parsed.spec,
      quote: raw.quote ?? false,
      origin: "inline",
      line: comment.line,
      comment: { line: comment.line, syntax: comment.syntax, span: comment.span },
      anchors: [anchor],
    };
    if (raw.sha256 !== undefined) c.sha256 = raw.sha256;
    const commit = raw.commit ?? defaultCommit;
    if (commit !== undefined) c.commit = commit;
    claim(c, comment.line);
  }

  const orphans: PageCitations["orphans"] = [];
  for (const { id, anchor } of references) {
    const target = byId.get(id);
    if (target) target.anchors.push(anchor);
    else orphans.push({ id, line: anchor.line });
  }
  return { entries, orphans };
}

/** Resolve one page's plan. Never throws; problems are collected per page. */
export function resolvePage(
  page: PageFile,
  config: DocevalsConfig,
): ResolvedPagePlan {
  const problems: PageProblem[] = [];
  const empty = {
    page,
    skip: false,
    suite: null,
    provenance: [],
    evals: [],
    citations: noCitations(),
    problems,
  };
  if (page.extractError) {
    problems.push({ message: page.extractError, level: "error", line: 1 });
    return empty;
  }

  const data = page.frontmatter.data;
  // The whole object, not just the eval keys: `eval-` prefix reservation is a
  // statement about the page root. Sibling tools' keys stay legal — the schema
  // root is open — but a typo'd `eval-*` setting is caught here instead of
  // being silently ignored, which is what the closed 0.1 block used to buy.
  if (!validateFrontmatter(data)) {
    for (const e of validateFrontmatter.errors ?? []) {
      problems.push({
        message: `frontmatter${e.instancePath}: ${describeError(e)}`,
        level: "error",
        line: page.frontmatter.lineFor(e.instancePath) ?? 1,
      });
    }
    return empty;
  }

  const fm = data as EvalFrontmatter;
  const pageSkip = fm["eval-skip"] ?? false;
  const provenance: EvalProvenance[] = (fm["eval-provenance"] ?? []).map((p) => ({
    generatedBy: p["generated-by"],
    evals: p.evals,
    confidence: p.confidence,
  }));
  const citations = resolveCitations(page, fm, problems);

  const declaredSuite = fm["eval-suite"];
  const suiteName = declaredSuite ?? config.defaults.suite;
  if (declaredSuite && !(declaredSuite in config.suites)) {
    problems.push({
      message: `Unknown suite "${declaredSuite}" (not defined in ${config.configPath})`,
      level: "error",
      line: page.frontmatter.lineFor("/eval-suite") ?? 1,
    });
    return { ...empty, skip: pageSkip, provenance, citations };
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
  // Every name an author wrote, collected before any shorthand is numbered.
  // Order matters: a shorthand at index 0 must yield to an explicit
  // `assertion-1` further down the list, not overwrite it.
  const claimed = new Set<string>(resolved.keys());
  for (const entry of evalEntries(fm.evals)) {
    if (typeof entry === "string") continue;
    claimed.add("use" in entry ? entry.use : entry.id);
  }
  for (const [i, entry] of evalEntries(fm.evals).entries()) {
    const linePtr = `/evals/${i}`;
    if (typeof entry === "string") {
      // String shorthand: an ai-judged assertion at error severity.
      //
      // In 0.1 a bare string was a *reference* to a config-defined eval, so a
      // page that still says `- fresh-enough` silently stops running the
      // freshness grader and sends the words "fresh-enough" to the judge
      // instead. Nothing errors; the eval simply disappears. Guessing the
      // author's intent would make a second, invisible spelling of `use:`, so
      // name the shape of the mistake and let them fix the page.
      if (entry in config.evals) {
        problems.push({
          message:
            `String shorthand "${entry}" matches an eval defined in ${config.configPath}, ` +
            `but a string is an assertion now, not a reference. ` +
            `Write "use: ${entry}" to run that eval.`,
          level: "warning",
          line: page.frontmatter.lineFor(linePtr) ?? 1,
        });
      }
      const name = shorthandName(i, claimed);
      claimed.add(name);
      resolved.set(
        name,
        fromDef(name, reportSuite, { assertion: entry }, "page"),
      );
      continue;
    }
    if ("use" in entry) {
      const ref = entry;
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
        weight: ref.weight ?? base.weight,
        options: { ...base.options, ...(ref.options ?? {}) },
        skip: ref.skip ?? base.skip,
      });
      continue;
    }

    const inline = entry;
    if (resolved.has(inline.id) && resolved.get(inline.id)?.source === "page") {
      // Overriding a *suite* eval by id is the documented precedence rule and
      // stays a silent, intended win. Two page-level entries sharing an id is
      // different: one of them is dropped, so the page checks less than it
      // declares — an error, not a warning that lets the run pass.
      problems.push({
        message: `Duplicate eval id "${inline.id}" on page — the later entry replaces the earlier one`,
        level: "error",
        line: page.frontmatter.lineFor(linePtr) ?? 1,
      });
    }
    const ev = fromDef(inline.id, reportSuite, normalizeEvalDef(inline), "page");
    ev.skip = inline.skip ?? false;
    resolved.set(inline.id, ev);
    if (ev.grader === "ai" && !inline.examples) {
      problems.push({
        message: `Eval "${inline.id}": ai-graded evals work best with examples.pass/examples.fail`,
        level: "warning",
        line: page.frontmatter.lineFor(linePtr) ?? 1,
      });
    }
  }

  // A citation nobody checks is decoration that looks like a guarantee. The
  // page did its part; the config is what is missing, so say which grader.
  if (
    citations.entries.length > 0 &&
    !pageSkip &&
    ![...resolved.values()].some((ev) => ev.grader === "tool:citations" && !ev.skip)
  ) {
    problems.push({
      message:
        `Page declares ${citations.entries.length} citation(s) but no eval with ` +
        `grader tool:citations applies to it, so nothing checks them. Define one ` +
        `in ${config.configPath} and attach it through a suite or "use:".`,
      level: "warning",
      line: citations.entries[0]?.line ?? 1,
    });
  }

  return {
    page,
    skip: pageSkip,
    suite: suiteName,
    generatedBy: fm["generated-by"],
    provenance,
    evals: [...resolved.values()],
    citations,
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
