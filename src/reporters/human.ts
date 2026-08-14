/** Human (terminal) reporter. */
import pc from "picocolors";
import type { EvalResult } from "../types.js";
import type { EngineReport } from "../core/engine.js";

function outcomeTag(r: EvalResult): string {
  switch (r.outcome) {
    case "pass":
      return pc.green("pass");
    case "fail":
      return pc.red("FAIL");
    case "needs-review":
      return pc.yellow("review");
    case "skipped":
      return pc.dim("skip");
    case "error":
      return pc.red("ERROR");
  }
}

export function renderHuman(report: EngineReport): string {
  const lines: string[] = [];

  const byFile = new Map<string, EvalResult[]>();
  for (const r of report.evalResults) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }

  for (const [file, results] of [...byFile.entries()].sort()) {
    lines.push(pc.bold(file));
    for (const r of results) {
      const zone = r.consensus ? pc.dim(` [${r.consensus.zone}]`) : "";
      const via = r.via ? pc.dim(" (human-reviewed)") : "";
      const gen = r.generated ? pc.cyan(" (generated)") : "";
      lines.push(`  ${outcomeTag(r)} ${r.evalName}${zone}${via}${gen}`);
      if (r.skipReason && r.outcome !== "pass") {
        lines.push(pc.dim(`       ${r.skipReason}`));
      }
      for (const f of r.findings ?? []) {
        const loc = f.line != null ? `:${f.line}` : "";
        const rule = f.ruleId ? pc.dim(` [${f.ruleId}]`) : "";
        const sev =
          f.severity === "error"
            ? pc.red(f.severity)
            : f.severity === "warning"
              ? pc.yellow(f.severity)
              : pc.dim(f.severity);
        lines.push(`       ${sev}${loc}${rule} ${f.message}`);
      }
      if (r.consensus && r.outcome !== "pass") {
        const v = r.consensus;
        lines.push(
          pc.dim(
            `       votes pass:${v.votes.pass} fail:${v.votes.fail} partial:${v.votes.partial}` +
              (v.votes.error ? ` error:${v.votes.error}` : "") +
              ` — confidence ${v.meanConfidence.toFixed(2)}`,
          ),
        );
        const reasoning = v.runs.find((run) => run.verdict)?.verdict?.reasoning;
        if (reasoning) lines.push(pc.dim(`       ${reasoning}`));
      }
    }
  }

  for (const p of report.problems) {
    const tag = p.level === "error" ? pc.red("error") : pc.yellow("warn");
    const loc = p.line != null ? `:${p.line}` : "";
    lines.push(`${tag} ${p.file}${loc} ${p.message}`);
  }

  if (report.generated.length > 0) {
    lines.push("");
    lines.push(pc.cyan(`Generated ${report.generated.length} check script(s):`));
    for (const g of report.generated) lines.push(`  ${g}`);
  }

  lines.push("");
  lines.push(pc.bold("Suites"));
  for (const s of report.suites) {
    const status = s.meetsTarget ? pc.green("ok") : pc.red("below target");
    const extras: string[] = [];
    if (s.needsReview > 0) extras.push(`${s.needsReview} to review`);
    if (s.skipped > 0) extras.push(`${s.skipped} skipped`);
    const extra = extras.length > 0 ? pc.dim(` (${extras.join(", ")})`) : "";
    lines.push(
      `  ${s.suite}: ${s.passed}/${s.passed + s.failed + s.errored} passed — ` +
        `${(s.passRate * 100).toFixed(0)}% vs target ${(s.targetPassRate * 100).toFixed(0)}% ${status}${extra}`,
    );
  }

  if (report.cost.judgedEvals > 0) {
    lines.push("");
    lines.push(
      pc.dim(
        `Judged ${report.cost.judgedEvals} evals (${report.cost.cachedEvals} cached), ` +
          `${report.cost.totalTokens.toLocaleString()} tokens` +
          (report.cost.totalUsd > 0
            ? `, ~$${report.cost.totalUsd.toFixed(4)}`
            : ""),
      ),
    );
  }

  const reviews = report.evalResults.filter(
    (r) => r.outcome === "needs-review",
  );
  if (reviews.length > 0) {
    lines.push("");
    lines.push(
      pc.yellow(
        `${reviews.length} eval(s) need human review — run \`moose-docevals review\` to record verdicts.`,
      ),
    );
  }

  return lines.join("\n");
}
