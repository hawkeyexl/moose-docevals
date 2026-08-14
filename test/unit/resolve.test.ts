import { describe, it, expect } from "vitest";
import { parseDocevalsConfig } from "../helpers/config.js";
import { resolvePage } from "../../src/core/resolve.js";
import { extractFrontmatter } from "docmeta";
import type { PageFile } from "../../src/core/discover.js";
import { stripFrontmatterBlock } from "../../src/core/discover.js";

const CONFIG = parseDocevalsConfig(
  [
    "version: 1",
    "evals:",
    "  central-llm:",
    "    assertion: Central claim holds.",
    "    examples: { pass: yes, fail: no }",
    "  central-tool:",
    "    grader: tool:freshness",
    "    options: { maxAgeDays: 100 }",
    "    severity: warning",
    "suites:",
    "  ref:",
    "    targetPassRate: 0.9",
    "    evals: [central-llm, central-tool]",
  ].join("\n"),
  "/fake/moose.config.yaml",
);

function page(frontmatterYaml: string, body = "Body."): PageFile {
  const content = `---\n${frontmatterYaml}\n---\n${body}`;
  return {
    file: "docs/page.md",
    absPath: "/fake/docs/page.md",
    content,
    body: stripFrontmatterBlock(content),
    frontmatter: extractFrontmatter(content, "markdown"),
  };
}

describe("resolvePage", () => {
  it("resolves suite evals from config", () => {
    const plan = resolvePage(page("evals:\n  suite: ref"), CONFIG);
    expect(plan.suite).toBe("ref");
    expect(plan.evals.map((e) => e.name).sort()).toEqual([
      "central-llm",
      "central-tool",
    ]);
    expect(plan.evals.every((e) => e.source === "config")).toBe(true);
  });

  it("defaults type to regression and grader to llm", () => {
    const plan = resolvePage(page("evals:\n  suite: ref"), CONFIG);
    const llm = plan.evals.find((e) => e.name === "central-llm")!;
    expect(llm.type).toBe("regression");
    expect(llm.grader).toBe("llm");
    expect(llm.severity).toBe("error");
  });

  it("applies string-shorthand references", () => {
    const plan = resolvePage(
      page("evals:\n  evals:\n    - central-llm"),
      CONFIG,
    );
    expect(plan.evals).toHaveLength(1);
    expect(plan.evals[0]?.name).toBe("central-llm");
  });

  it("accepts the array shorthand for the evals key", () => {
    const plan = resolvePage(
      page(
        [
          "evals:",
          "  - central-llm",
          "  - name: inline-check",
          "    assertion: Inline claim.",
          "    examples: { pass: yes, fail: no }",
        ].join("\n"),
      ),
      CONFIG,
    );
    expect(plan.problems.filter((p) => p.level === "error")).toHaveLength(0);
    expect(plan.evals.map((e) => e.name).sort()).toEqual([
      "central-llm",
      "inline-check",
    ]);
  });

  it("reports line-accurate problems in the array shorthand", () => {
    const plan = resolvePage(page("evals:\n  - ghost"), CONFIG);
    const err = plan.problems.find((p) => p.level === "error");
    expect(err?.message).toMatch(/Unknown eval "ghost"/);
    expect(err?.line).toBe(3);
  });

  it("merges reference overrides onto suite evals", () => {
    const plan = resolvePage(
      page(
        [
          "evals:",
          "  suite: ref",
          "  evals:",
          "    - use: central-tool",
          "      severity: error",
          "      type: capability",
          "      options: { maxAgeDays: 30 }",
        ].join("\n"),
      ),
      CONFIG,
    );
    const tool = plan.evals.find((e) => e.name === "central-tool")!;
    expect(tool.severity).toBe("error");
    expect(tool.type).toBe("capability");
    expect(tool.options).toEqual({ maxAgeDays: 30 });
    // Not duplicated by the reference.
    expect(plan.evals.filter((e) => e.name === "central-tool")).toHaveLength(1);
  });

  it("resolves inline evals as page-sourced", () => {
    const plan = resolvePage(
      page(
        [
          "evals:",
          "  evals:",
          "    - name: my-inline",
          "      assertion: Inline claim.",
          "      examples: { pass: yes, fail: no }",
        ].join("\n"),
      ),
      CONFIG,
    );
    expect(plan.evals[0]?.source).toBe("page");
    expect(plan.evals[0]?.suite).toBe("default");
  });

  it("warns when an inline llm eval lacks examples", () => {
    const plan = resolvePage(
      page(
        "evals:\n  evals:\n    - name: bare\n      assertion: Claim.",
      ),
      CONFIG,
    );
    expect(plan.problems.some((p) => p.level === "warning" && /examples/.test(p.message))).toBe(true);
  });

  it("reports unknown eval references as errors with a line", () => {
    const plan = resolvePage(
      page("evals:\n  evals:\n    - ghost"),
      CONFIG,
    );
    const err = plan.problems.find((p) => p.level === "error");
    expect(err?.message).toMatch(/Unknown eval "ghost"/);
    expect(err?.line).toBeGreaterThan(1);
  });

  it("reports an unknown suite as an error", () => {
    const plan = resolvePage(page("evals:\n  suite: ghost"), CONFIG);
    expect(plan.problems[0]?.message).toMatch(/Unknown suite "ghost"/);
    expect(plan.evals).toHaveLength(0);
  });

  it("rejects malformed moose-docevals frontmatter via schema", () => {
    const plan = resolvePage(
      page("evals:\n  evals:\n    - name: Bad_Name\n      assertion: x"),
      CONFIG,
    );
    expect(plan.problems.some((p) => p.level === "error")).toBe(true);
    expect(plan.evals).toHaveLength(0);
  });

  it("requires assertion for llm-graded inline evals", () => {
    const plan = resolvePage(
      page("evals:\n  evals:\n    - name: no-claim"),
      CONFIG,
    );
    expect(plan.problems.some((p) => p.level === "error")).toBe(true);
  });

  it("allows command-graded inline evals with only an assertion (generation target)", () => {
    const plan = resolvePage(
      page(
        [
          "evals:",
          "  evals:",
          "    - name: gen-me",
          "      assertion: Deterministic claim.",
          "      grader: command",
        ].join("\n"),
      ),
      CONFIG,
    );
    expect(plan.problems.filter((p) => p.level === "error")).toHaveLength(0);
    expect(plan.evals[0]?.command).toBeUndefined();
  });

  it("honors page and eval skip flags", () => {
    const plan = resolvePage(
      page(
        [
          "evals:",
          "  skip: true",
          "  evals:",
          "    - use: central-llm",
          "      skip: true",
        ].join("\n"),
      ),
      CONFIG,
    );
    expect(plan.skip).toBe(true);
    expect(plan.evals[0]?.skip).toBe(true);
  });

  it("uses defaults.suite for pages without a moose-docevals key", () => {
    const cfg = parseDocevalsConfig(
      [
        "version: 1",
        "defaults: { suite: ref }",
        "evals:",
        "  central-llm:",
        "    assertion: Central claim holds.",
        "suites:",
        "  ref:",
        "    evals: [central-llm]",
      ].join("\n"),
      "/fake/moose.config.yaml",
    );
    const plan = resolvePage(page("title: Plain"), cfg);
    expect(plan.suite).toBe("ref");
    expect(plan.evals.map((e) => e.name)).toEqual(["central-llm"]);
  });

  it("surfaces extraction errors as page problems", () => {
    const p = page("title: x");
    p.extractError = "Invalid YAML frontmatter: boom";
    const plan = resolvePage(p, CONFIG);
    expect(plan.problems[0]?.message).toMatch(/boom/);
    expect(plan.evals).toHaveLength(0);
  });
});
