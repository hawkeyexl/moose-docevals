/**
 * GitHub Actions reporter: workflow commands for inline PR annotations,
 * followed by the markdown summary (suitable for $GITHUB_STEP_SUMMARY).
 */
import type { EngineReport } from "../core/engine.js";
import { renderMarkdown } from "./markdown.js";

function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function renderGithub(report: EngineReport): string {
  const lines: string[] = [];
  for (const r of report.evalResults) {
    for (const f of r.findings ?? []) {
      const level = f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "notice";
      const props = [
        `file=${escapeProperty(f.file)}`,
        f.line != null ? `line=${f.line}` : undefined,
        f.col != null ? `col=${f.col}` : undefined,
        `title=${escapeProperty(`moose-docevals: ${f.evalName}`)}`,
      ]
        .filter(Boolean)
        .join(",");
      lines.push(`::${level} ${props}::${escapeData(f.message)}`);
    }
    if (r.outcome === "fail" && r.consensus) {
      const reasoning =
        r.consensus.runs.find((run) => run.verdict)?.verdict?.reasoning ?? "";
      lines.push(
        `::error file=${escapeProperty(r.file)},title=${escapeProperty(`moose-docevals: ${r.evalName}`)}::${escapeData(
          `AI judge: fail (confidence ${r.consensus.meanConfidence.toFixed(2)}). ${reasoning}`,
        )}`,
      );
    }
  }
  for (const p of report.problems) {
    const level = p.level === "error" ? "error" : "warning";
    const props = [
      `file=${escapeProperty(p.file)}`,
      p.line != null ? `line=${p.line}` : undefined,
      `title=moose-docevals`,
    ]
      .filter(Boolean)
      .join(",");
    lines.push(`::${level} ${props}::${escapeData(p.message)}`);
  }
  lines.push("", renderMarkdown(report));
  return lines.join("\n");
}
