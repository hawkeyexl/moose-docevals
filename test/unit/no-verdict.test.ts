/**
 * Every grader's "the tool did not produce a readable verdict" path, enumerated.
 *
 * ADR 01022 states the invariant once and enforces it once, in the engine: a
 * finding marked `diagnostic: true` fails its eval whatever the severity,
 * because "no verdict" must never read as "pass". What it could not do is make
 * an adapter *remember to set the flag*, and two rounds of checking that by
 * inspection both reported the adapters clean while instances remained:
 *
 * - ADR 01020 surveyed the other five and found "no second instance". There
 *   were three, which ADR 01022 documents.
 * - ADR 01022 then claimed the flag was applied "across all six graders".
 *   There were four more (ADR 01023).
 *
 * So this file replaces inspection with enumeration. Every path below is one
 * where the tool did not answer the question, driven through the real adapter
 * with a fake exec. Each eval is at `severity: warning` deliberately: at the
 * default `error` these assertions pass whether the flag is set or not, which
 * is exactly how the previous round's tests managed to be vacuous.
 *
 * Adding a grader means adding its rows here.
 */
import { describe, it, expect } from "vitest";
import { extractFrontmatter } from "docmeta";
import { parseDocevalsConfig } from "../helpers/config.js";
import { resolvePage, type ResolvedPagePlan } from "../../src/core/resolve.js";
import type { PageFile } from "../../src/core/discover.js";
import { commandGrader } from "../../src/graders/command.js";
import { docDetectiveGrader } from "../../src/graders/tools/doc-detective.js";
import { docStructureLintGrader } from "../../src/graders/tools/doc-structure-lint.js";
import { markdownlintGrader } from "../../src/graders/tools/markdownlint.js";
import { remarkGrader } from "../../src/graders/tools/remark.js";
import { valeGrader } from "../../src/graders/tools/vale.js";
import { citationsGrader } from "../../src/graders/native/citations.js";
import type { FetchLike } from "../../src/citations/source.js";
import type { Grader, ExecFn, ExecResult, GraderTarget } from "../../src/graders/types.js";

/** An eval at warning severity, so only the flag can fail it. */
function targetFor(grader: string, extra: string[] = []): {
  target: GraderTarget;
  config: ReturnType<typeof parseDocevalsConfig>;
} {
  const config = parseDocevalsConfig(
    [
      "version: 1",
      "evals:",
      "  check:",
      "    assertion: The page holds up.",
      `    grader: ${grader}`,
      "    severity: warning",
      ...extra,
      "suites:",
      "  s: { evals: [check] }",
    ].join("\n"),
    "/fake/moose.config.yaml",
  );
  const content = `---
title: x
eval-suite: s
---
Body.`;
  const page: PageFile = {
    file: "docs/page.md",
    absPath: "/fake/docs/page.md",
    content,
    body: "Body.",
    frontmatter: extractFrontmatter(content, "markdown"),
  };
  const plan: ResolvedPagePlan = resolvePage(page, config);
  if (plan.evals.length === 0) throw new Error(`no eval resolved for ${grader}`);
  return { target: { plan, eval: plan.evals[0]! }, config };
}

const fakeExec =
  (result: Partial<ExecResult>): ExecFn =>
  () =>
    Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...result });

async function findingsFrom(
  grader: Grader,
  graderKind: string,
  execResult: Partial<ExecResult>,
  extra: string[] = [],
) {
  const { target, config } = targetFor(graderKind, extra);
  return grader.grade({
    targets: [target],
    config,
    root: "/fake",
    exec: fakeExec(execResult),
  });
}

const TEMPLATE = ["    options:", '      template: "how-to"'];

// Each row: the grader, the shape of the tool's non-answer, and a label.
const NO_VERDICT: [string, Grader, string, Partial<ExecResult>, string[]][] = [
  ["command: spawn failure", commandGrader, "command", { spawnError: "ENOENT", code: null },
    ["    command: [does-not-exist]"]],
  ["command: timeout", commandGrader, "command", { timedOut: true, code: null },
    ["    command: [sleep, \"99\"]"]],

  ["doc-detective: spawn failure", docDetectiveGrader, "tool:doc-detective",
    { spawnError: "ENOENT", code: null }, []],
  ["doc-detective: timeout", docDetectiveGrader, "tool:doc-detective",
    { timedOut: true, code: null, stderr: "partial" }, []],
  ["doc-detective: non-zero exit with nothing readable", docDetectiveGrader,
    "tool:doc-detective", { code: 2, stdout: "", stderr: "Unknown argument: run" }, []],

  ["doc-structure-lint: no options.template", docStructureLintGrader,
    "tool:doc-structure-lint", { code: 0, stdout: "[]" }, []],
  ["doc-structure-lint: spawn failure", docStructureLintGrader,
    "tool:doc-structure-lint", { spawnError: "ENOENT", code: null }, TEMPLATE],
  ["doc-structure-lint: unreadable stdout at exit 0", docStructureLintGrader,
    "tool:doc-structure-lint", { code: 0, stdout: "Structure OK!" }, TEMPLATE],

  ["markdownlint: spawn failure", markdownlintGrader, "tool:markdownlint",
    { spawnError: "ENOENT", code: null }, []],
  ["markdownlint: timeout", markdownlintGrader, "tool:markdownlint",
    { timedOut: true, code: null, stderr: "partial" }, []],
  ["markdownlint: non-zero exit with nothing parseable", markdownlintGrader,
    "tool:markdownlint", { code: 2, stderr: "Cannot read config" }, []],

  ["remark: spawn failure", remarkGrader, "tool:remark",
    { spawnError: "ENOENT", code: null }, []],
  ["remark: timeout", remarkGrader, "tool:remark",
    { timedOut: true, code: null, stderr: "partial" }, []],
  ["remark: no JSON report", remarkGrader, "tool:remark",
    { code: 1, stderr: "Error: cannot find plugin remark-mdx" }, []],
  ["remark: report is not a list of files", remarkGrader, "tool:remark",
    { code: 0, stderr: '{"ok":true}' }, []],

  ["vale: spawn failure", valeGrader, "tool:vale", { spawnError: "ENOENT", code: null }, []],
  ["vale: no JSON output", valeGrader, "tool:vale",
    { code: 2, stdout: "", stderr: "config error" }, []],
];

describe("a grader that reached no verdict marks it", () => {
  it.each(NO_VERDICT)("%s", async (_label, grader, kind, execResult, extra) => {
    const findings = await findingsFrom(grader, kind, execResult, extra);
    // Silence is the failure this exists to catch: no finding at all is the
    // shape ADR 01020 opened with, and it reads as a pass.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.diagnostic === true)).toBe(true);
    // Severity is display only. Rewriting it here would be ADR 01022's
    // rejected option 2, and would take `warning` away from real findings.
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });
});

// The complement. Without it, `diagnostic: true` on every finding would pass
// the block above while destroying what severity means.
describe("a real page problem is not a diagnostic", () => {
  it("markdownlint lint output", async () => {
    const findings = await findingsFrom(markdownlintGrader, "tool:markdownlint", {
      code: 1,
      stdout: "docs/page.md:1 MD041/first-line-heading First line in a file should be a top-level heading",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.diagnostic).toBeUndefined();
    expect(findings[0]?.severity).toBe("warning");
  });

  it("a command that simply exits non-zero", async () => {
    const findings = await findingsFrom(commandGrader, "command", { code: 1, stdout: "nope" }, [
      '    command: ["false"]',
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.diagnostic).toBeUndefined();
  });
});

// `tool:citations` reads sources, not tool output, so its no-verdict shapes
// are a source it cannot reach and a hash that was never true at the commit
// it names. Both go through the injected fetch; git is never spawned here.
describe("tool:citations marks a no-verdict too", () => {
  const HASH = "0".repeat(64);
  const URL = "https://github.com/o/r/blob/main/x.sh#L1";
  const SOURCE = "one\ntwo\n";

  function citedTarget(comment: string): { target: GraderTarget; config: ReturnType<typeof parseDocevalsConfig> } {
    const config = parseDocevalsConfig(
      [
        "version: 1",
        "evals:",
        "  check:",
        "    assertion: Cited sources are current.",
        "    grader: tool:citations",
        "    severity: warning",
        "suites:",
        "  s: { evals: [check] }",
      ].join("\n"),
      "/fake/moose.config.yaml",
    );
    const content = `---\ntitle: x\neval-suite: s\n---\n${comment}\nClaim.\n`;
    const page: PageFile = {
      file: "docs/page.md",
      absPath: "/fake/docs/page.md",
      content,
      body: `${comment}\nClaim.\n`,
      frontmatter: extractFrontmatter(content, "markdown"),
    };
    const plan = resolvePage(page, config);
    if (plan.evals.length === 0) throw new Error("no eval resolved");
    return { target: { plan, eval: plan.evals[0]! }, config };
  }

  const grade = (comment: string, fetch: FetchLike) => {
    const { target, config } = citedTarget(comment);
    return citationsGrader.grade({
      targets: [target],
      config,
      root: "/fake",
      exec: fakeExec({ spawnError: "ENOENT", code: null }),
      fetch,
    });
  };

  it("citations: source unreachable", async () => {
    const findings = await grade(
      `<!-- cite: src=${URL} sha256=${HASH} -->`,
      () => Promise.reject(new Error("ECONNRESET")),
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.diagnostic === true)).toBe(true);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("citations: hash never true at the recorded commit", async () => {
    const findings = await grade(
      `<!-- cite: src=${URL} sha256=${HASH} commit=4d1e7c0 -->`,
      () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SOURCE) }),
    );
    expect(findings.map((f) => f.ruleId)).toEqual(["citations/never-true"]);
    expect(findings.every((f) => f.diagnostic === true)).toBe(true);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  // The complement, as above: a source that changed is a page problem.
  it("a changed citation is not a diagnostic", async () => {
    const findings = await grade(
      `<!-- cite: src=${URL} sha256=${HASH} -->`,
      () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SOURCE) }),
    );
    expect(findings.map((f) => f.ruleId)).toEqual(["citations/changed"]);
    expect(findings[0]?.diagnostic).toBeUndefined();
    expect(findings[0]?.severity).toBe("warning");
  });
});
