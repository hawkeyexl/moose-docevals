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
import { exited } from "../exec.js";
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
      let parsed: DslResult[];
      try {
        parsed = JSON.parse(result.stdout) as DslResult[];
      } catch {
        if (result.code !== 0) {
          findings.push({
            evalName: ev.name,
            file: plan.page.file,
            message: `doc-structure-lint ${exited(result.code)}: ${result.stderr.trim().slice(-300)}`,
            severity: ev.severity,
          });
        }
        continue;
      }
      for (const r of parsed) {
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
