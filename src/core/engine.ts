/**
 * Pipeline orchestration: discover → resolve → deterministic graders (cheap
 * first, the book's hybrid pattern) → LLM judge → aggregate → report.
 *
 * The judge is injected (`options.judge`) so the deterministic pipeline and
 * tests run without any provider configured.
 */
import type {
  EvalResult,
  Finding,
  RunReport,
  SuiteSummary,
} from "../types.js";
import { loadConfig, type DocevalsConfig } from "./config.js";
import { discoverPages } from "./discover.js";
import { resolvePages, type ResolvedPagePlan } from "./resolve.js";
import { graderFor } from "../graders/registry.js";
import { realExec } from "../graders/exec.js";
import type { ExecFn, GraderTarget } from "../graders/types.js";
import { sha256 } from "../judge/cache.js";

export interface RunProblem {
  file: string;
  message: string;
  level: "error" | "warning";
  line?: number;
}

/** RunReport plus resolution problems (kept off the core type for reporters). */
export interface EngineReport extends RunReport {
  problems: RunProblem[];
}

export interface JudgeOptions {
  provider?: string;
  model?: string;
  runs?: number;
  noCache?: boolean;
  maxCostUsd?: number | null;
}

/** Injected LLM judging stage; absent → llm evals are skipped. */
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
  llmOnly?: boolean;
  frontmatterCommands?: boolean;
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

function summarizeSuites(
  results: EvalResult[],
  plans: ResolvedPagePlan[],
  config: DocevalsConfig,
): SuiteSummary[] {
  // Suite membership comes from the resolved eval, recorded per result.
  const suiteOf = new Map<string, string>();
  for (const plan of plans) {
    for (const ev of plan.evals) {
      suiteOf.set(resultKey(plan.page.file, ev.name), ev.suite);
    }
  }
  const bySuite = new Map<string, EvalResult[]>();
  for (const r of results) {
    const suite = suiteOf.get(resultKey(r.file, r.evalName)) ?? "default";
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
    const graded = passed + failed + errored;
    const passRate = graded > 0 ? passed / graded : 1;
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
      meetsTarget: passRate >= targetPassRate,
    });
  }
  return summaries;
}

export async function runEvals(options: RunOptions = {}): Promise<EngineReport> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(options.configPath, cwd);
  const exec = options.exec ?? realExec;
  const pages = discoverPages(config, options.globs ?? [], cwd);
  const plans = resolvePages(pages, config);
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
  const llmTargets: GraderTarget[] = [];
  const generationTargets: GraderTarget[] = [];
  const generatedPaths: string[] = [];
  /** "<file> <evalName>" keys whose check script this run generated. */
  const generatedThisRun = new Set<string>();

  const allowFrontmatterCommands =
    (options.frontmatterCommands ?? true) &&
    config.scripts.allowFrontmatterCommands;

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
      if (ev.grader === "llm") {
        if (options.deterministicOnly) {
          results.push(skippedResult(plan, ev, "judge skipped (--deterministic-only)"));
        } else if (!options.judge) {
          results.push(skippedResult(plan, ev, "judge unavailable (no provider)"));
        } else {
          llmTargets.push({ plan, eval: ev });
        }
        continue;
      }
      // command / tool:* — deterministic.
      if (options.llmOnly) {
        results.push(skippedResult(plan, ev, "deterministic evals skipped (--llm-only)"));
        continue;
      }
      if (ev.grader === "command" && ev.source === "page" && !allowFrontmatterCommands) {
        results.push(
          skippedResult(plan, ev, "frontmatter commands disabled"),
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
        ev.generated &&
        ev.assertion &&
        ev.generated.assertionHash !== sha256(ev.assertion)
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
    const findings = await grader.grade({
      targets,
      config,
      root: cwd,
      exec,
    });
    const durationMs = Date.now() - start;
    allFindings.push(...findings);
    const grouped = groupFindings(findings);
    for (const t of targets) {
      const key = resultKey(t.plan.page.file, t.eval.name);
      const own = grouped.get(key) ?? [];
      const hasError = own.some((f) => f.severity === "error");
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

  // failFast: a page with an error-severity deterministic failure skips its LLM evals.
  let effectiveLlmTargets = llmTargets;
  if (config.defaults.failFast) {
    const failedPages = new Set(
      results
        .filter((r) => r.outcome === "fail" || r.outcome === "error")
        .map((r) => r.file),
    );
    effectiveLlmTargets = [];
    for (const t of llmTargets) {
      if (failedPages.has(t.plan.page.file)) {
        results.push(
          skippedResult(t.plan, t.eval, "deterministic-precondition-failed"),
        );
      } else {
        effectiveLlmTargets.push(t);
      }
    }
  }

  // LLM judge stage.
  if (effectiveLlmTargets.length > 0 && options.judge) {
    results.push(
      ...(await options.judge(effectiveLlmTargets, config, judgeOptions)),
    );
  }

  const suites = summarizeSuites(results, plans, config);
  const judged = results.filter((r) => r.consensus != null);
  const totalUsd = results.reduce((n, r) => n + (r.costUsd ?? 0), 0);
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
    suites.some((s) => !s.meetsTarget) ||
    problems.some((p) => p.level === "error") ||
    (options.failOnReview === true &&
      results.some((r) => r.outcome === "needs-review"));

  return {
    pages: plans.length,
    evalResults: results,
    suites,
    cost: {
      totalUsd,
      totalTokens,
      cachedEvals: judged.filter((r) =>
        r.consensus!.runs.every((run) => run.cached),
      ).length,
      judgedEvals: judged.length,
    },
    generated: generatedPaths,
    exitCode: hasFailure ? 1 : 0,
    problems,
  };
}
