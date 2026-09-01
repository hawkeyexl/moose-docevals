/**
 * Pipeline orchestration: discover → resolve → deterministic graders (cheap
 * first, the book's hybrid pattern) → AI judge → aggregate → report.
 *
 * The judge is injected (`options.judge`) so the deterministic pipeline and
 * tests run without any provider configured.
 */
import { DocevalsError } from "../types.js";
import type {
  EvalResult,
  Finding,
  RunReport,
  SuiteSummary,
} from "../types.js";
import { loadConfig, type DocevalsConfig, type ExecutionGrant } from "./config.js";
import { discoverPages } from "./discover.js";
import { resolvePages, type ResolvedPagePlan } from "./resolve.js";
import {
  applyBaseline,
  buildBaseline,
  countFingerprints,
  diffBaselines,
  readBaseline,
  writeBaselineFile,
  DEFAULT_BASELINE_PATH,
  type Baseline,
  type FingerprintContext,
} from "./baseline.js";
import { graderFor } from "../graders/registry.js";
import { checkFeasibility } from "./feasibility.js";
import { realExec } from "../graders/exec.js";
import type { ExecFn, GraderTarget } from "../graders/types.js";
import { sha256 } from "../judge/cache.js";
import { isTurnBudgetSkip } from "../judge/budget.js";
import { resolve } from "node:path";

export interface RunProblem {
  file: string;
  message: string;
  level: "error" | "warning";
  line?: number;
}

/** RunReport plus resolution problems (kept off the core type for reporters). */
export interface EngineReport extends RunReport {
  problems: RunProblem[];
  /** Present only when a baseline was read or written (ADR 01017). */
  baseline?: BaselineOutcome["summary"];
}

export interface JudgeOptions {
  provider?: string;
  model?: string;
  runs?: number;
  noCache?: boolean;
  /** Stop after this many uncached inference calls (ADR 01019). */
  maxTurns?: number | null;
}

/** Injected AI judging stage; absent → ai-graded evals are skipped. */
export type JudgeFn = (
  targets: GraderTarget[],
  config: DocevalsConfig,
  options: JudgeOptions,
) => Promise<EvalResult[]>;

/** Injected script-generation stage (Phase 4); absent → missing commands error. */
export type GenerateFn = (
  targets: GraderTarget[],
  config: DocevalsConfig,
  options: JudgeOptions,
) => Promise<{ generatedPaths: string[] }>;

export interface RunOptions {
  configPath?: string;
  /** Preloaded config; skips loading/validating configPath a second time. */
  config?: DocevalsConfig;
  globs?: string[];
  cwd?: string;
  deterministicOnly?: boolean;
  aiOnly?: boolean;
  /** Additional execution grants for this run; never widens beyond these. */
  allowExecution?: ExecutionGrant[];
  /** `false` clears every grant for this run. */
  execution?: boolean;
  /** Run only these evals by name. Empty match is a usage error (ADR 01018). */
  evalNames?: string[];
  /** Run only evals belonging to this suite. */
  suite?: string;
  /**
   * Baseline in four states, like docmeta's: `undefined` leaves the config in
   * charge, a string names a file, `true` means "use the resolved path even if
   * the config names none", and `false` disables it outright.
   */
  baseline?: string | boolean;
  /** Record the run's findings as the new baseline. `true` uses the resolved path. */
  writeBaseline?: string | boolean;
  /**
   * Stamped into a written baseline's `generatedWith`, for diagnosis only. The
   * engine is a library entry point and cannot read its own package.json in a
   * bundle, so the CLI supplies it rather than the engine guessing.
   */
  toolVersion?: string;
  generate?: boolean;
  failOnReview?: boolean;
  judgeOptions?: JudgeOptions;
  exec?: ExecFn;
  judge?: JudgeFn;
  generateScripts?: GenerateFn;
}

function skippedResult(
  plan: ResolvedPagePlan,
  ev: ResolvedPagePlan["evals"][number],
  reason: string,
): EvalResult {
  return {
    evalName: ev.name,
    type: ev.type,
    grader: ev.grader,
    file: plan.page.file,
    outcome: "skipped",
    skipReason: reason,
    durationMs: 0,
  };
}

/**
 * Collision-proof composite key for (file, eval) maps — file paths may
 * contain any character, so field boundaries must be unambiguous.
 */
function resultKey(file: string, evalName: string): string {
  return JSON.stringify([file, evalName]);
}

function groupFindings(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = resultKey(f.file, f.evalName);
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return map;
}

/**
 * Record each result's suite on the result itself.
 *
 * The mapping is already computed here for the summaries; without stamping it,
 * a reporter that wants to group by suite (JUnit) has no way to, and a
 * consumer of `--format json` sees pass rates per suite with no way to tell
 * which results produced them.
 */
function stampSuites(
  results: EvalResult[],
  plans: ResolvedPagePlan[],
): void {
  const suiteOf = new Map<string, string>();
  const weightOf = new Map<string, number>();
  for (const plan of plans) {
    for (const ev of plan.evals) {
      const key = resultKey(plan.page.file, ev.name);
      suiteOf.set(key, ev.suite);
      weightOf.set(key, ev.weight);
    }
  }
  for (const r of results) {
    const key = resultKey(r.file, r.evalName);
    r.suite = suiteOf.get(key) ?? "default";
    // A result with no matching plan entry cannot be weighted from one, so it
    // counts as 1 rather than 0 — dropping it out of the denominator would let
    // an unresolvable eval quietly raise a suite's rate.
    r.weight = weightOf.get(key) ?? 1;
  }
}

export interface BaselineOutcome {
  results: EvalResult[];
  /** Present only when a baseline was read or written. */
  summary?: {
    path: string;
    recorded: number;
    suppressed: number;
    stale: number;
    written?: { added: number; removed: number; total: number };
  };
}

/**
 * Read, apply, and optionally re-record the findings baseline (ADR 01017).
 *
 * The path is resolved once, here, and both reading and writing use it. That is
 * deliberate: a bare `--write-baseline` must record into the *configured* path,
 * because a repo that points `baseline:` somewhere custom would otherwise
 * record into a file nothing ever reads — and the ratchet would silently do
 * nothing at all. docmeta names this exact trap.
 */
function resolveBaseline(
  results: EvalResult[],
  config: DocevalsConfig,
  options: RunOptions,
  cwd: string,
  problems: RunProblem[],
): BaselineOutcome {
  const wants = options.writeBaseline !== undefined && options.writeBaseline !== false;
  if (options.baseline === false && !wants) return { results };

  // Read and write paths resolve separately. Sharing one made
  // `--baseline old.json --write-baseline new.json` read old.json and then
  // overwrite it, never creating new.json.
  //
  // A bare `--baseline` falls back to the configured path and then the
  // default. `--write-baseline` does NOT force that fallback on the *read*
  // side: `--write-baseline snapshot.json` in a repo with no `baseline:` key
  // should not silently subtract a file the user never named.
  const readFallback =
    config.baseline ?? (options.baseline === true ? DEFAULT_BASELINE_PATH : null);
  const applyFrom =
    options.baseline === false
      ? null
      : typeof options.baseline === "string"
        ? options.baseline
        : readFallback;
  const writeTo = !wants
    ? null
    : typeof options.writeBaseline === "string"
      ? options.writeBaseline
      : (config.baseline ?? DEFAULT_BASELINE_PATH);
  const configured = writeTo ?? applyFrom;
  if (configured === null) return { results };

  // Relative to the config's directory, not the working directory: the file is
  // committed beside the config, and a run from a subdirectory has to find the
  // same one.
  const ctx: FingerprintContext = { base: config.configDir, runBase: cwd };
  // A baseline that cannot be parsed must not block the one command documented
  // to repair it. Reading unconditionally made `--write-baseline` throw the
  // very error whose message recommends running it.
  const read = (from: string): Baseline | null => {
    try {
      return readBaseline(resolve(config.configDir, from), from);
    } catch (e) {
      if (!wants) throw e;
      problems.push({
        file: from,
        message: `${e instanceof Error ? e.message : String(e)} — re-recording over it.`,
        level: "warning",
      });
      return null;
    }
  };

  // What gets subtracted from this run's findings. Null under --no-baseline.
  const previous = applyFrom === null ? null : read(applyFrom);
  // What is about to be overwritten. This is what `removed` must be measured
  // against — not `previous`, which may be a different file or, under
  // --no-baseline, deliberately unread. Measuring the diff against the wrong
  // prior silently reported `-0` for a re-record that dropped everything.
  const overwriting =
    writeTo === null ? null : writeTo === applyFrom ? previous : read(writeTo);

  let out = results;
  let recorded = 0;
  let suppressed = 0;
  let stale = 0;
  if (previous && options.baseline !== false) {
    const applied = applyBaseline(results, previous, ctx);
    out = applied.results;
    recorded = applied.recorded;
    suppressed = applied.suppressed;
    stale = applied.stale;
  }

  if (!wants) {
    return {
      results: out,
      summary: { path: configured, recorded, suppressed, stale },
    };
  }

  // Recorded from the *unsuppressed* results: a re-record describes what the
  // corpus contains now, not what this run happened to still be complaining
  // about after the previous baseline was subtracted.
  const next = buildBaseline(results, options.toolVersion ?? "unknown", ctx);
  writeBaselineFile(resolve(config.configDir, writeTo!), next, writeTo!);
  const { added, removed } = diffBaselines(overwriting, next);
  // Apply the baseline this run just wrote, not the one it replaced. Recording
  // today's findings *is* declaring them the accepted state, so a recording run
  // has nothing new left to fail on. Reporting them as failures anyway would
  // make `--write-baseline` a command you always have to `|| true`, which is a
  // reliable way to lose the exit code that matters on the next run.
  const accepted = applyBaseline(results, next, ctx);
  // Writing a baseline nothing will read is the same silent-nothing-happens
  // failure as recording into the wrong path: the command succeeds, the file
  // appears, and the next run ignores it. Say so where the user is looking.
  // Fires whenever an ordinary run would not read back what was just written:
  // no `baseline:` at all, or a `--write-baseline <path>` pointing somewhere
  // the config does not name.
  if (config.baseline !== writeTo) {
    problems.push({
      file: writeTo!,
      message:
        `Recorded ${writeTo!}, but \`baseline:\` in ${config.configPath} is ` +
        `${config.baseline === null ? "not set" : `"${config.baseline}"`}. ` +
        `An ordinary run will not read this file — point the key at it, or pass --baseline ${writeTo!}.`,
      level: "warning",
    });
  }
  return {
    results: accepted.results,
    summary: {
      path: configured,
      recorded,
      suppressed,
      stale,
      written: { added, removed, total: countFingerprints(next) },
    },
  };
}

/**
 * Narrow each plan's evals to the requested names and/or suite, in place.
 *
 * Returns whether a filter was applied, which is what suspends suite
 * enforcement downstream. A filter matching nothing is a usage error rather
 * than a green run over zero evals — the same contract `discoverPages` already
 * enforces for an empty input set (ADR 01018).
 */
export function applySelection(
  plans: ResolvedPagePlan[],
  config: DocevalsConfig,
  options: { evalNames?: string[]; suite?: string },
  /**
   * Whether a match must be something the run would actually grade.
   *
   * True for `run`, where a filter matching only skipped work would exit 0
   * having executed nothing. False for `list`, which executes nothing by
   * design — showing that an eval resolves but is skipped is the answer it
   * exists to give, and throwing there breaks the command the run's own error
   * message points at.
   */
  requireRunnable = true,
): boolean {
  const names = options.evalNames?.filter((n) => n.trim() !== "") ?? [];
  const suite = options.suite;
  if (names.length === 0 && suite === undefined) return false;

  if (suite !== undefined && !(suite in config.suites)) {
    throw new DocevalsError(
      `--suite "${suite}" is not a defined suite. Defined: ${
        Object.keys(config.suites).sort().join(", ") || "(none)"
      }`,
    );
  }
  const wanted = new Set(names);

  // Counts only evals that will actually be graded. Counting evals on a
  // skipped page made `--eval x` exit 0 over a run that executed nothing,
  // which is the outcome ADR 01018 makes a usage error one typo away.
  let matched = 0;
  for (const plan of plans) {
    const runnable = !plan.skip && !plan.problems.some((p) => p.level === "error");
    plan.evals = plan.evals.filter((ev) => {
      const byName = wanted.size === 0 || wanted.has(ev.name);
      // Match the suite an eval *reports under*, not the membership list in
      // `config.suites[x].evals`. A page inherits its suite from `eval-suite`
      // or `defaults.suite` and stamps it on every eval it carries, including
      // page-inline ones the membership list never mentions — so filtering on
      // the list would select evals that report under a different suite than
      // the one asked for, and miss ones that report under it.
      const bySuite = suite === undefined || ev.suite === suite;
      const keep = byName && bySuite;
      if (keep && (!requireRunnable || (runnable && !ev.skip))) matched += 1;
      return keep;
    });
  }

  if (matched === 0) {
    const asked = [
      names.length > 0 ? `--eval ${names.join(", ")}` : "",
      suite === undefined ? "" : `--suite ${suite}`,
    ]
      .filter(Boolean)
      .join(" and ");
    throw new DocevalsError(
      `${asked} matched no evals that would run on the pages selected. Nothing ` +
        `would have been checked — the name may be wrong, or every page carrying ` +
        `it may be skipped. Run \`moose-docevals list\` with the same filter to ` +
        `see the resolved plan.`,
    );
  }
  return true;
}

/**
 * Per-suite aggregates. Reads the suite `stampSuites` recorded on each result
 * rather than rebuilding the plan-to-suite map a second time — two copies of
 * one derivation are two things to keep in agreement.
 */
function summarizeSuites(
  results: EvalResult[],
  config: DocevalsConfig,
  partial = false,
): SuiteSummary[] {
  const bySuite = new Map<string, EvalResult[]>();
  for (const r of results) {
    const suite = r.suite ?? "default";
    const list = bySuite.get(suite) ?? [];
    list.push(r);
    bySuite.set(suite, list);
  }
  const summaries: SuiteSummary[] = [];
  for (const [suite, rs] of [...bySuite.entries()].sort()) {
    const passed = rs.filter((r) => r.outcome === "pass").length;
    const failed = rs.filter((r) => r.outcome === "fail").length;
    const errored = rs.filter((r) => r.outcome === "error").length;
    const needsReview = rs.filter((r) => r.outcome === "needs-review").length;
    const skipped = rs.filter((r) => r.outcome === "skipped").length;
    // Counts stay unweighted and per-eval: they report how many evals did
    // what, and a reader comparing "1 failed" against a rate of 0.33 is
    // reading two different questions, both answered honestly.
    //
    // The rate is weighted over the same membership as before — the graded
    // set, pass + fail + error. `needs-review` and `skipped` stay out of both
    // halves, so a page awaiting review neither helps nor hurts.
    const graded = (r: EvalResult): boolean =>
      r.outcome === "pass" || r.outcome === "fail" || r.outcome === "error";
    const suiteCriteria = config.suites[suite]?.criteria ?? [];

    const contributions: { weight: number; passed: boolean }[] = [];

    // Criteria first, because which evals a criterion actually absorbs is only
    // known once it is evaluated. A group scored once is the whole point —
    // three checks written as a criterion must not outvote three standalone
    // evals just for being grouped.
    let critPassed = 0;
    let critFailed = 0;
    let critSuspended = 0;
    /** "<file> <evalName>" of members a *scored* criterion speaks for. */
    const absorbed = new Set<string>();
    for (const critName of suiteCriteria) {
      const def = config.criteria[critName];
      if (!def) continue;
      const pages = new Set(
        rs.filter((r) => def.evals.includes(r.evalName)).map((r) => r.file),
      );
      for (const file of pages) {
        const members = def.evals.map((name) =>
          rs.find((r) => r.file === file && r.evalName === name),
        );
        // Every member must have been graded for the group to mean anything.
        // A missing or ungraded member suspends it rather than failing it.
        if (members.some((m) => m === undefined || !graded(m))) {
          critSuspended++;
          // Deliberately does NOT absorb its members. A suspended criterion
          // contributes nothing, so absorbing them too would delete their
          // outcomes from the rate entirely — a failing member would move the
          // total by nothing and silently inflate the suite.
          continue;
        }
        const passes = members.map((m) => m?.outcome === "pass");
        const passed =
          def.combine === "any" ? passes.some(Boolean) : passes.every(Boolean);
        if (passed) critPassed++;
        else critFailed++;
        contributions.push({ weight: def.weight, passed });
        for (const m of members) {
          if (m) absorbed.add(resultKey(m.file, m.evalName));
        }
      }
    }

    // Standalone evals: everything a scored criterion did not speak for.
    for (const r of rs) {
      if (!graded(r) || absorbed.has(resultKey(r.file, r.evalName))) continue;
      contributions.push({ weight: r.weight ?? 1, passed: r.outcome === "pass" });
    }

    const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
    const passRate =
      totalWeight > 0
        ? contributions
            .filter((c) => c.passed)
            .reduce((sum, c) => sum + c.weight, 0) / totalWeight
        : 1;
    const targetPassRate = config.suites[suite]?.targetPassRate ?? 1.0;
    summaries.push({
      suite,
      total: rs.length,
      passed,
      failed,
      needsReview,
      skipped,
      errored,
      passRate,
      targetPassRate,
      // A suite target is a claim about a body of checks. A filtered run
      // measured part of it, so it reports the numbers and withholds the
      // verdict — erring toward false confidence is what gets a gate removed
      // rather than fixed (ADR 01018).
      meetsTarget: partial ? false : passRate >= targetPassRate,
      ...(partial ? { partial: true } : {}),
      ...(suiteCriteria.length > 0
        ? {
            criteria: {
              total: critPassed + critFailed + critSuspended,
              passed: critPassed,
              failed: critFailed,
              suspended: critSuspended,
            },
          }
        : {}),
    });
  }
  return summaries;
}

export async function runEvals(options: RunOptions = {}): Promise<EngineReport> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(options.configPath, cwd);
  const exec = options.exec ?? realExec;
  const pages = discoverPages(config, options.globs ?? [], cwd);
  // Refused up front, not at the end: a re-record rebuilds the file from this
  // run's findings, so recording from a filtered run would drop every
  // fingerprint the filter excluded. Deciding it here costs nothing; deciding
  // it after `resolveBaseline` meant the generation pass had already written
  // scripts and rewritten frontmatter, and the judge had already been paid.
  if (
    options.writeBaseline !== undefined &&
    options.writeBaseline !== false &&
    ((options.evalNames?.some((n) => n.trim() !== "") ?? false) ||
      options.suite !== undefined)
  ) {
    throw new DocevalsError(
      "--write-baseline records the whole corpus, so it cannot be combined with " +
        "--eval or --suite: the re-record would drop every finding the filter " +
        "excluded. Re-run without the filter to record.",
    );
  }

  const plans = resolvePages(pages, config);
  const filtered = applySelection(plans, config, options);
  const judgeOptions = options.judgeOptions ?? {};

  const problems: RunProblem[] = plans.flatMap((p) =>
    p.problems.map((pr) => ({
      file: p.page.file,
      message: pr.message,
      level: pr.level,
      line: pr.line,
    })),
  );

  const results: EvalResult[] = [];
  const deterministicTargets: GraderTarget[] = [];
  const aiTargets: GraderTarget[] = [];
  const generationTargets: GraderTarget[] = [];
  const generatedPaths: string[] = [];
  /** "<file> <evalName>" keys whose check script this run generated. */
  const generatedThisRun = new Set<string>();

  // Default deny, with the CLI able to withhold a configured grant but never
  // to widen one: `--allow-execution` on the command line is still an operator
  // act, so it grants; `--no-execution` clears everything for one run.
  const granted = new Set<ExecutionGrant>([
    ...config.execution.allow,
    ...(options.allowExecution ?? []),
  ]);
  if (options.execution === false) granted.clear();
  const allowFrontmatterCommands = granted.has("frontmatter-commands");
  const allowPageEmbeddedSteps = granted.has("page-embedded-steps");

  // Before anything is dispatched: an eval that cannot reach a verdict as
  // configured is a configuration error, and saying so now costs nothing where
  // discovering it at grade time costs a judge call.
  problems.push(
    ...checkFeasibility(plans, {
      allowFrontmatterCommands,
      canGenerate: options.generate !== false && options.generateScripts != null,
      ...(options.deterministicOnly === true ? { deterministicOnly: true } : {}),
      ...(options.aiOnly === true ? { aiOnly: true } : {}),
    }),
  );

  for (const plan of plans) {
    if (plan.problems.some((p) => p.level === "error")) continue;
    for (const ev of plan.evals) {
      if (plan.skip) {
        results.push(skippedResult(plan, ev, "page skipped (evals.skip)"));
        continue;
      }
      if (ev.skip) {
        results.push(skippedResult(plan, ev, "eval skipped"));
        continue;
      }
      if (ev.grader === "human") {
        results.push({
          evalName: ev.name,
          type: ev.type,
          grader: ev.grader,
          file: plan.page.file,
          outcome: "needs-review",
          durationMs: 0,
        });
        continue;
      }
      if (ev.grader === "ai") {
        if (options.deterministicOnly) {
          results.push(skippedResult(plan, ev, "judge skipped (--deterministic-only)"));
        } else if (!options.judge) {
          results.push(skippedResult(plan, ev, "judge unavailable (no provider)"));
        } else {
          aiTargets.push({ plan, eval: ev });
        }
        continue;
      }
      // command / tool:* — deterministic.
      if (options.aiOnly) {
        results.push(skippedResult(plan, ev, "deterministic evals skipped (--ai-only)"));
        continue;
      }
      if (ev.grader === "command" && ev.source === "page" && !allowFrontmatterCommands) {
        results.push(
          skippedResult(
            plan,
            ev,
            "frontmatter commands not granted (execution.allow: [frontmatter-commands])",
          ),
        );
        continue;
      }
      // The second path from content to a shell: doc-detective executes steps
      // written in the page *body*, which no flag covered before. Same grant
      // model, different capability — an operator who trusts a repo's
      // frontmatter has not thereby trusted arbitrary steps in its prose.
      if (ev.grader === "tool:doc-detective" && !allowPageEmbeddedSteps) {
        results.push(
          skippedResult(
            plan,
            ev,
            "page-embedded steps not granted (execution.allow: [page-embedded-steps])",
          ),
        );
        continue;
      }
      if (ev.grader === "command" && !ev.command) {
        generationTargets.push({ plan, eval: ev });
        continue;
      }
      // Stale generated script: the assertion changed since generation.
      if (
        ev.grader === "command" &&
        ev.command &&
        ev.generatedAssertionHash &&
        ev.assertion &&
        ev.generatedAssertionHash !== sha256(ev.assertion)
      ) {
        if (options.generate !== false && options.generateScripts) {
          generationTargets.push({ plan, eval: ev });
          continue;
        }
        problems.push({
          file: plan.page.file,
          message: `Eval "${ev.name}": assertion changed since its script was generated — run \`moose-docevals generate\` to regenerate`,
          level: "warning",
        });
      }
      deterministicTargets.push({ plan, eval: ev });
    }
  }

  // Script generation for command evals with no command yet.
  if (generationTargets.length > 0) {
    if (options.generate !== false && options.generateScripts) {
      const gen = await options.generateScripts(
        generationTargets,
        config,
        judgeOptions,
      );
      generatedPaths.push(...gen.generatedPaths);
      // Re-read the targets' evals: generateScripts mutates eval.command in place.
      for (const t of generationTargets) {
        if (t.eval.command) {
          deterministicTargets.push(t);
          // Surfaced by the reporters as "(generated)" on this run's result.
          generatedThisRun.add(resultKey(t.plan.page.file, t.eval.name));
        } else {
          results.push({
            evalName: t.eval.name,
            type: t.eval.type,
            grader: t.eval.grader,
            file: t.plan.page.file,
            outcome: "error",
            skipReason: "script generation failed",
            generated: false,
            durationMs: 0,
          });
        }
      }
    } else {
      for (const t of generationTargets) {
        results.push({
          evalName: t.eval.name,
          type: t.eval.type,
          grader: t.eval.grader,
          file: t.plan.page.file,
          outcome: "error",
          skipReason:
            "no command and script generation unavailable (configure a provider or run `moose-docevals generate`)",
          durationMs: 0,
        });
      }
    }
  }

  // Deterministic graders, grouped by kind.
  const byKind = new Map<string, GraderTarget[]>();
  for (const t of deterministicTargets) {
    const list = byKind.get(t.eval.grader) ?? [];
    list.push(t);
    byKind.set(t.eval.grader, list);
  }

  const allFindings: Finding[] = [];
  for (const [kind, targets] of byKind) {
    const grader = graderFor(kind);
    if (!grader) {
      for (const t of targets) {
        results.push({
          evalName: t.eval.name,
          type: t.eval.type,
          grader: t.eval.grader,
          file: t.plan.page.file,
          outcome: "error",
          skipReason: `Unknown grader kind "${kind}"`,
          durationMs: 0,
        });
      }
      continue;
    }
    const start = Date.now();
    // A grader is effectively third-party code: tool adapters shell out, and
    // `runValidate` raises on a schema path it cannot read — which
    // `options.schemas` being hand-written makes the likeliest route in.
    // Letting that rejection escape drops every remaining eval on every
    // remaining page with no result and no exit-code signal that anything was
    // skipped. Error its own targets and carry on, the way a failed script
    // generation already does above.
    let findings: Finding[];
    try {
      findings = await grader.grade({ targets, config, root: cwd, exec });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      for (const target of targets) {
        results.push({
          evalName: target.eval.name,
          suite: target.eval.suite,
          type: target.eval.type,
          grader: target.eval.grader,
          file: target.plan.page.file,
          outcome: "error",
          skipReason: `grader ${kind} failed: ${reason}`,
          durationMs: Date.now() - start,
        });
      }
      continue;
    }
    const durationMs = Date.now() - start;
    allFindings.push(...findings);
    const grouped = groupFindings(findings);
    for (const t of targets) {
      const key = resultKey(t.plan.page.file, t.eval.name);
      const own = grouped.get(key) ?? [];
      // A diagnostic finding fails the eval regardless of severity: it means
      // the grader could not reach a verdict, and "no verdict" must never read
      // as "pass". Enforced here rather than per-adapter, so a new adapter
      // gets it by default instead of having to remember (ADR 01022).
      const hasError = own.some(
        (f) => f.severity === "error" || f.diagnostic === true,
      );
      results.push({
        evalName: t.eval.name,
        type: t.eval.type,
        grader: t.eval.grader,
        file: t.plan.page.file,
        outcome: hasError ? "fail" : "pass",
        findings: own.length > 0 ? own : undefined,
        generated: generatedThisRun.has(key) ? true : undefined,
        durationMs: Math.round(durationMs / targets.length),
      });
    }
  }

  // failFast: a page with an error-severity deterministic failure skips its ai evals.
  let effectiveAiTargets = aiTargets;
  if (config.defaults.failFast) {
    const failedPages = new Set(
      results
        .filter((r) => r.outcome === "fail" || r.outcome === "error")
        .map((r) => r.file),
    );
    effectiveAiTargets = [];
    for (const t of aiTargets) {
      if (failedPages.has(t.plan.page.file)) {
        results.push(
          skippedResult(t.plan, t.eval, "deterministic-precondition-failed"),
        );
      } else {
        effectiveAiTargets.push(t);
      }
    }
  }

  // AI judge stage.
  if (effectiveAiTargets.length > 0 && options.judge) {
    results.push(
      ...(await options.judge(effectiveAiTargets, config, judgeOptions)),
    );
  }

  // A run that ran out of turns has *reduced coverage*, and skipped evals are
  // excluded from the suite pass rate below — so without this it exits 0
  // having judged less than it was asked to, which is the silent-green shape
  // this corpus gate exists to prevent. Warning, not error: the cap was asked
  // for, so tripping it is expected; going quiet about it is not (ADR 01019).
  const budgetSkipped = results.filter((r) => isTurnBudgetSkip(r.skipReason));
  if (budgetSkipped.length > 0) {
    problems.push({
      file: budgetSkipped[0]!.file,
      message:
        `${budgetSkipped.length} eval(s) were not judged: the turn budget ran out. ` +
        `This run covered less than it was asked to — raise --max-turns or narrow the run.`,
      level: "warning",
    });
  }

  const baselineOutcome = resolveBaseline(results, config, options, cwd, problems);
  // Copy before clearing: when no baseline applies, `resolveBaseline` hands
  // back the very array it was given, and emptying it first would leave the
  // spread with nothing to read — a run reporting zero results, green.
  const baselinedResults = [...baselineOutcome.results];
  results.length = 0;
  results.push(...baselinedResults);

  stampSuites(results, plans);

  const suites = summarizeSuites(results, config, filtered);
  const judged = results.filter((r) => r.consensus != null);
  const totalTokens = judged.reduce(
    (n, r) =>
      n +
      (r.consensus?.runs.reduce(
        (m, run) =>
          m + (run.usage ? run.usage.inputTokens + run.usage.outputTokens : 0),
        0,
      ) ?? 0),
    0,
  );

  const hasFailure =
    results.some((r) => r.outcome === "fail" || r.outcome === "error") ||
    suites.some((s) => s.partial !== true && !s.meetsTarget) ||
    problems.some((p) => p.level === "error") ||
    (options.failOnReview === true &&
      results.some((r) => r.outcome === "needs-review"));

  return {
    pages: plans.length,
    evalResults: results,
    suites,
    usage: {
      totalTokens,
      cachedEvals: judged.filter((r) =>
        r.consensus!.runs.every((run) => run.cached),
      ).length,
      judgedEvals: judged.length,
    },
    generated: generatedPaths,
    exitCode: hasFailure ? 1 : 0,
    problems,
    ...(baselineOutcome.summary ? { baseline: baselineOutcome.summary } : {}),
  };
}
