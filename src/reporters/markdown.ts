/** Markdown reporter: PR-comment-friendly summary. */
import type { EngineReport } from "../core/engine.js";

const OUTCOME_ICON: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  "needs-review": "🟡",
  skipped: "⏭️",
  error: "🛑",
};

export function renderMarkdown(report: EngineReport): string {
  const lines: string[] = ["## moose-docevals results", ""];

  lines.push("| Suite | Passed | Failed | Review | Pass rate | Target | |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of report.suites) {
    lines.push(
      `| ${s.suite} | ${s.passed} | ${s.failed + s.errored} | ${s.needsReview} | ` +
        `${(s.passRate * 100).toFixed(0)}% | ${(s.targetPassRate * 100).toFixed(0)}% | ` +
        // A filtered run measured part of the suite: no verdict, so
        // neither mark. Rendering ❌ made every filtered run look failed
        // (ADR 01018).
        `${s.partial ? "➖ partial" : s.meetsTarget ? "✅" : "❌"} |`,
    );
  }

  const notable = report.evalResults.filter(
    (r) => r.outcome === "fail" || r.outcome === "error" || r.outcome === "needs-review",
  );
  if (notable.length > 0) {
    lines.push("", "### Findings", "");
    for (const r of notable) {
      const icon = OUTCOME_ICON[r.outcome] ?? "";
      lines.push(`- ${icon} **${r.evalName}** — \`${r.file}\``);
      for (const f of r.findings ?? []) {
        const loc = f.line != null ? `:${f.line}` : "";
        lines.push(`  - ${f.severity}${loc}: ${f.message}`);
      }
      if (r.consensus) {
        const v = r.consensus;
        const reasoning = v.runs.find((run) => run.verdict)?.verdict?.reasoning;
        lines.push(
          `  - votes pass:${v.votes.pass} fail:${v.votes.fail} partial:${v.votes.partial}, confidence ${v.meanConfidence.toFixed(2)} (${v.zone})`,
        );
        if (reasoning) lines.push(`  - ${reasoning}`);
      }
      if (r.skipReason && r.outcome === "error") lines.push(`  - ${r.skipReason}`);
    }
  }

  for (const p of report.problems) {
    lines.push(`- ⚠️ \`${p.file}\`${p.line != null ? `:${p.line}` : ""} ${p.message}`);
  }

  if (report.generated.length > 0) {
    lines.push("", "### Generated scripts", "");
    for (const g of report.generated) lines.push(`- \`${g}\``);
  }

  if (report.usage.judgedEvals > 0) {
    lines.push(
      "",
      `_Judged ${report.usage.judgedEvals} evals (${report.usage.cachedEvals} cached), ` +
        `${report.usage.totalTokens.toLocaleString()} tokens._`,
    );
  }
  return lines.join("\n");
}
