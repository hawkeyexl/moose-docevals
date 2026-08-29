/**
 * `tool:doc-structure-lint` — the last grader without a test, and the one with
 * the failure mode the corpus gate exists to prevent: it could return no
 * findings for output it could not read, which reads as a pass.
 *
 * Tested against captured tool output plus a fake exec, never a real binary.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { extractFrontmatter } from "docmeta";
import { parseDocevalsConfig } from "../helpers/config.js";
import { stripFrontmatterBlock, type PageFile } from "../../src/core/discover.js";
import { resolvePage } from "../../src/core/resolve.js";
import { docStructureLintGrader } from "../../src/graders/tools/doc-structure-lint.js";
import type { ExecFn, ExecResult, GraderTarget } from "../../src/graders/types.js";

const CONFIG = parseDocevalsConfig("version: 1\n", "/fake/moose.config.yaml");
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tool-output");
const captured = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

function makeTarget(options = 'options: { template: "how-to" }'): GraderTarget {
  const content = [
    "---",
    "evals:",
    "  - id: well-structured",
    "    assertion: The page follows the how-to template.",
    "    grader: tool:doc-structure-lint",
    `    ${options}`,
    "---",
    "Body.",
  ].join("\n");
  const page: PageFile = {
    file: "docs/page.md",
    absPath: "/fake/docs/page.md",
    content,
    body: stripFrontmatterBlock(content),
    frontmatter: extractFrontmatter(content, "markdown"),
  };
  const plan = resolvePage(page, CONFIG);
  if (plan.evals.length === 0) throw new Error("fixture resolved no evals");
  return { plan, eval: plan.evals[0]! };
}

function fakeExec(result: Partial<ExecResult>): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = (cmd) => {
    calls.push(cmd);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...result });
  };
  return { exec, calls };
}

const grade = (exec: ExecFn, target = makeTarget()) =>
  docStructureLintGrader.grade({ targets: [target], config: CONFIG, root: "/fake", exec });

describe("docStructureLintGrader", () => {
  it("reports nothing when the tool reports no errors", async () => {
    const { exec, calls } = fakeExec({ stdout: captured("doc-structure-lint-pass.json") });
    expect(await grade(exec)).toEqual([]);
    expect(calls[0]).toContain("--template");
    expect(calls[0]).toContain("how-to");
    expect(calls[0]).toContain("--json");
  });

  it("turns each structure error into a finding with its position", async () => {
    const { exec } = fakeExec({
      code: 1,
      stdout: captured("doc-structure-lint-fail.json"),
    });
    const findings = await grade(exec);

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      evalName: "well-structured",
      file: "docs/page.md",
      ruleId: "missing-section",
      line: 12,
      col: 1,
    });
    // The heading is prefixed onto the message when the tool supplies one, so
    // a reader can tell which section is at fault without opening the page.
    expect(findings[0]?.message).toContain("Prerequisites");
    expect(findings[1]?.ruleId).toBe("sequence");
    expect(findings[1]?.line).toBe(30);
  });

  it("reports a missing options.template rather than running the tool", async () => {
    const { exec, calls } = fakeExec({});
    const findings = await grade(exec, makeTarget("options: {}"));
    expect(calls).toHaveLength(0);
    expect(findings[0]?.message).toMatch(/options\.template/);
  });

  it("reports a tool that could not be spawned", async () => {
    const { exec } = fakeExec({ spawnError: "ENOENT" });
    const findings = await grade(exec);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/Failed to run doc-structure-lint/);
  });

  it("reports a non-zero exit whose output is not JSON", async () => {
    const { exec } = fakeExec({ code: 2, stdout: "not json", stderr: "boom" });
    const findings = await grade(exec);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/boom/);
  });

  // The silent pass. Unparseable output with exit 0 used to fall through to
  // `continue` with no finding, so the eval passed on output nobody could
  // read. That is the same green-with-nothing-executed shape ci.yml added an
  // explicit guard for on doc-detective.
  it("reports unreadable output even when the tool exits 0", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "Structure OK!" });
    const findings = await grade(exec);
    expect(findings, "exit 0 with unparseable output must not pass silently").toHaveLength(1);
    expect(findings[0]?.message).toMatch(/could not be read|not valid JSON|unreadable/i);
  });

  // Valid JSON of the wrong shape is the same hazard wearing a disguise: it
  // parses, so the try/catch never fires, and iterating it is a runtime error
  // rather than a finding.
  it("reports valid JSON that is not the expected shape", async () => {
    const { exec } = fakeExec({ code: 0, stdout: '{"ok":true}' });
    const findings = await grade(exec);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/could not be read|shape|unexpected/i);
  });
});
