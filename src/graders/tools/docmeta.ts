/**
 * Tool adapter: docmeta. Runs in-process via docmeta's programmatic API — no
 * subprocess, identical behavior to `docmeta validate`. Runs once per
 * eval-configuration group so evals with different schema sets validate
 * independently. Options:
 *   schemas: array of schema refs (builtin ids, file paths, or URLs).
 */
import { runValidate } from "docmeta";
import type { Finding } from "../../types.js";
import { groupTargetsByEval, type Grader, type GraderContext, type GraderTarget } from "../types.js";

async function gradeGroup(
  ctx: GraderContext,
  targets: GraderTarget[],
): Promise<Finding[]> {
  const first = targets[0]!;
  const schemas = first.eval.options.schemas as string[] | undefined;
  const byFile = new Map(targets.map((t) => [t.plan.page.file, t.eval] as const));
  const files = [...byFile.keys()];

  // Which schemas a corpus is held to is not something moose-docevals can
  // guess. Passing `cliSchemas: undefined` would hand the decision to docmeta's
  // own `DEFAULT_SCHEMAS`, a set that has widened twice across major versions —
  // so the eval's meaning would change on a dependency bump with no edit to any
  // config here. Measured on the 1.3 → 4.12 upgrade: with no `schemas`, all 13
  // fixture pages fail `google:okf:0.1` for a missing `type`, reported as if
  // the pages were wrong rather than the eval underspecified.
  if (!schemas || schemas.length === 0) {
    return targets.map((t) => ({
      evalName: t.eval.name,
      file: t.plan.page.file,
      ruleId: "docmeta/no-schemas",
      message:
        "tool:docmeta needs options.schemas (builtin ids, file paths, or URLs) — " +
        'e.g. schemas: ["node_modules/moose-docevals/schemas/frontmatter-1.0.0.json"]',
      severity: t.eval.severity,
      line: 1,
    }));
  }

  const run = await runValidate({
    inputs: files,
    cliSchemas: schemas,
    cwd: ctx.root,
  });

  const findings: Finding[] = [];
  for (const result of run.results) {
    const file = result.file.replace(/\\/g, "/");
    const ev = byFile.get(file);
    if (!ev || result.ok) continue;
    for (const err of result.errors) {
      findings.push({
        evalName: ev.name,
        file,
        ruleId: err.schema,
        message: err.instancePath
          ? `${err.instancePath}: ${err.message}`
          : err.message,
        severity: ev.severity,
        line: err.line,
        col: err.col,
      });
    }
  }
  return findings;
}

export const docmetaGrader: Grader = {
  kind: "tool:docmeta",
  mode: "batch",
  async grade(ctx) {
    const findings: Finding[] = [];
    for (const group of groupTargetsByEval(ctx.targets)) {
      findings.push(...(await gradeGroup(ctx, group)));
    }
    return findings;
  },
};
