/**
 * Grader contract for deterministically graded evals (command and tool:*).
 * A grader receives every (page, eval) target that resolved to its kind and
 * returns normalized findings. AI grading lives in src/judge, not here.
 */
import type { ExecFn } from "@hawkeyexl/inference";
import type { Finding } from "../types.js";
import type { DocevalsConfig } from "../core/config.js";
import type { ResolvedEval, ResolvedPagePlan } from "../core/resolve.js";

/** One (page, eval) pair a grader must grade. */
export interface GraderTarget {
  plan: ResolvedPagePlan;
  eval: ResolvedEval;
}

// The exec seam is shared with the inference layer's subprocess provider, so
// these types live there now. Re-exported so grader code keeps importing them
// from one place.
export type { ExecFn, ExecOptions, ExecResult } from "@hawkeyexl/inference";

export interface GraderContext {
  targets: GraderTarget[];
  config: DocevalsConfig;
  /** Discovery root; page paths are relative to it. */
  root: string;
  exec: ExecFn;
}

export interface Grader {
  /** Registry kind, e.g. "command", "tool:markdownlint", "tool:freshness". */
  kind: string;
  /**
   * Targets other than `body` this grader can actually read.
   *
   * Declared by the grader rather than listed in the engine, so adding a
   * grader that reads `target` is a change in one file. Absent means "body
   * only", which is every grader that predates `target` — and the engine
   * turns any other request into an error rather than letting the grader
   * quietly measure the whole page (ADR 01033).
   */
  targets?: readonly string[];
  /**
   * batch: one external invocation covers all targets;
   * per-file: one invocation per target;
   * corpus: needs every page at once (cross-page checks).
   */
  mode: "batch" | "per-file" | "corpus";
  grade(ctx: GraderContext): Promise<Finding[]>;
}

/**
 * Split targets into groups that share an eval configuration. Batch and
 * corpus graders run one invocation per group so that (a) two same-kind evals
 * on one page each get their own run and correct finding attribution, and
 * (b) per-page option overrides are honored instead of the first target's
 * options being applied to everyone.
 */
export function groupTargetsByEval(targets: GraderTarget[]): GraderTarget[][] {
  const groups = new Map<string, GraderTarget[]>();
  for (const t of targets) {
    const key = JSON.stringify([
      t.eval.name,
      t.eval.options,
      t.eval.timeoutMs ?? null,
      t.eval.severity,
      t.eval.severityMap ?? null,
    ]);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  return [...groups.values()];
}
