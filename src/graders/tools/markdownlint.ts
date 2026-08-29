/**
 * Tool adapter: markdownlint-cli2. Runs once per eval-configuration group
 * (batch) over that group's files and parses the default text output:
 *
 *   path/to/file.md:12:3 MD013/line-length Line length [Expected: 80 ...]
 *   path/to/file.md:9 MD041/first-line-heading First line ...
 */
import type { Finding } from "../../types.js";
import { groupTargetsByEval, type Grader, type GraderContext, type GraderTarget } from "../types.js";

const LINE = /^(.+?):(\d+)(?::(\d+))?\s+(MD\d+(?:\/[\w-]+)*)\s+(.*)$/;

export function parseMarkdownlintOutput(output: string): {
  file: string;
  line: number;
  col?: number;
  ruleId: string;
  message: string;
}[] {
  const results = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    results.push({
      file: m[1]!.replace(/\\/g, "/"),
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : undefined,
      ruleId: m[4]!,
      message: m[5]!,
    });
  }
  return results;
}

async function gradeGroup(
  ctx: GraderContext,
  targets: GraderTarget[],
): Promise<Finding[]> {
  const first = targets[0]!;
  const commandOverride = first.eval.options.command as string[] | undefined;
  const files = [...new Set(targets.map((t) => t.plan.page.file))];
  const cmd = [
    ...(commandOverride ?? ["npx", "--no-install", "markdownlint-cli2"]),
    ...files,
  ];
  const result = await ctx.exec(cmd, {
    cwd: ctx.root,
    timeoutMs: first.eval.timeoutMs ?? 120000,
  });
  if (result.spawnError) {
    return targets.map(({ plan, eval: ev }) => ({
      evalName: ev.name,
      file: plan.page.file,
      message: `Failed to run markdownlint-cli2: ${result.spawnError ?? "spawn failed"} (is it installed?)`,
      severity: ev.severity,
      diagnostic: true,
    }));
  }

  const byFile = new Map(targets.map((t) => [t.plan.page.file, t.eval] as const));
  const findings: Finding[] = [];
  // markdownlint-cli2 writes findings to stderr; parse both streams to be safe.
  for (const item of parseMarkdownlintOutput(
    `${result.stderr}\n${result.stdout}`,
  )) {
    const ev = byFile.get(item.file);
    if (!ev) continue; // Output for a file we didn't target.
    findings.push({
      evalName: ev.name,
      file: item.file,
      ruleId: item.ruleId,
      message: item.message,
      severity: ev.severity,
      line: item.line,
      col: item.col,
    });
  }
  return findings;
}

export const markdownlintGrader: Grader = {
  kind: "tool:markdownlint",
  mode: "batch",
  async grade(ctx) {
    const findings: Finding[] = [];
    for (const group of groupTargetsByEval(ctx.targets)) {
      findings.push(...(await gradeGroup(ctx, group)));
    }
    return findings;
  },
};
