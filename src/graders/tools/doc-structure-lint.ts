/**
 * Tool adapter: doc-structure-lint. Validates page structure against a named
 * YAML template. Options:
 *   template (required): template name to apply
 *   templatePath: path to templates.yaml
 *   command: override for the executable
 * JSON output shape: [{ file, success, errors: [{ type, heading, message,
 * position: { start: { line }, ... } }] }]
 */
import type { Finding } from "../../types.js";
import { exited, outputTail } from "../exec.js";
import type { Grader } from "../types.js";

interface DslError {
  type?: string;
  heading?: string;
  message?: string;
  position?: { start?: { line?: number; column?: number } };
}

interface DslResult {
  file?: string;
  success?: boolean;
  errors?: DslError[];
}

export const docStructureLintGrader: Grader = {
  kind: "tool:doc-structure-lint",
  mode: "per-file",
  async grade(ctx) {
    const findings: Finding[] = [];
    for (const { plan, eval: ev } of ctx.targets) {
      const template = ev.options.template as string | undefined;
      if (!template) {
        findings.push({
          evalName: ev.name,
          file: plan.page.file,
          message: 'tool:doc-structure-lint needs options.template (e.g. "how-to")',
          severity: ev.severity,
        });
        continue;
      }
      const commandOverride = ev.options.command as string[] | undefined;
      const templatePath = ev.options["template-path"] as string | undefined;
      const cmd = [
        ...(commandOverride ?? ["npx", "--no-install", "doc-structure-lint"]),
        "--file-path",
        plan.page.file,
        "--template",
        template,
        ...(templatePath ? ["--template-path", templatePath] : []),
        "--json",
      ];
      const result = await ctx.exec(cmd, {
        cwd: ctx.root,
        timeoutMs: ev.timeoutMs ?? 120000,
      });
      if (result.spawnError) {
        findings.push({
          evalName: ev.name,
          file: plan.page.file,
          message: `Failed to run doc-structure-lint: ${result.spawnError} (is it installed?)`,
          severity: ev.severity,
        });
        continue;
      }
      // Output this grader cannot read is a finding, never a pass.
      //
      // Both branches below used to end in a bare `continue`: unparseable
      // stdout with exit 0 produced no finding at all, and valid JSON of the
      // wrong shape reached the loop and threw `parsed is not iterable`. The
      // first is the green-with-nothing-checked failure the corpus gate exists
      // to prevent — the same hazard ci.yml added an explicit guard for on
      // doc-detective, where a page whose steps all fail to parse reports
      // success. An eval must not pass because its tool became unreadable.
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        findings.push({
          evalName: ev.name,
          file: plan.page.file,
          message:
            result.code === 0
              ? `doc-structure-lint exited 0 but its output could not be read as JSON: ${outputTail(result)}`
              : `doc-structure-lint ${exited(result.code)}: ${result.stderr.trim().slice(-300)}`,
          severity: ev.severity,
        });
        continue;
      }
      if (!Array.isArray(parsed)) {
        findings.push({
          evalName: ev.name,
          file: plan.page.file,
          message: `doc-structure-lint returned JSON of an unexpected shape (expected a list of results): ${outputTail(result)}`,
          severity: ev.severity,
        });
        continue;
      }
      for (const r of parsed as DslResult[]) {
        for (const err of r.errors ?? []) {
          findings.push({
            evalName: ev.name,
            file: plan.page.file,
            ruleId: err.type,
            message: err.heading
              ? `${err.heading}: ${err.message ?? "structure error"}`
              : (err.message ?? "structure error"),
            severity: ev.severity,
            line: err.position?.start?.line,
            col: err.position?.start?.column,
          });
        }
      }
    }
    return findings;
  },
};
