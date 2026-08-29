/**
 * `tool:docmeta` must be told which schemas to validate against.
 *
 * The adapter passes `options.schemas` straight through as `cliSchemas`. When
 * that is undefined, docmeta falls back to its own `DEFAULT_SCHEMAS` — a set
 * that has widened twice across major versions (2.0.0 added Diátaxis and
 * Seven-Action, 3.0.0 added The Good Docs Project). Inheriting it means an
 * eval's meaning changes on a dependency bump, with no edit to any config in
 * this repo.
 *
 * Measured on the upgrade to 4.12.0: with no `schemas` option, all 13 fixture
 * pages fail `google:okf:0.1` for a missing `type` — a vocabulary nobody here
 * opted into. Which schemas a corpus is held to is not something moose-docevals
 * can guess, so it asks.
 */
import { describe, it, expect } from "vitest";
import { extractFrontmatter } from "docmeta";
import { docmetaGrader } from "../../src/graders/tools/docmeta.js";
import { resolvePage } from "../../src/core/resolve.js";
import { stripFrontmatterBlock } from "../../src/core/discover.js";
import { parseDocevalsConfig } from "../helpers/config.js";
import type { PageFile } from "../../src/core/discover.js";
import type { GraderTarget } from "../../src/graders/types.js";

const CONFIG = parseDocevalsConfig(
  [
    "version: 1",
    "evals:",
    "  fm-bare:",
    "    assertion: Frontmatter validates.",
    "    grader: tool:docmeta",
    "  fm-aimed:",
    "    assertion: Frontmatter validates.",
    "    grader: tool:docmeta",
    "    options:",
    '      schemas: ["schemas/frontmatter-1.0.0.json"]',
    "suites:",
    "  bare: { evals: [fm-bare] }",
    "  aimed: { evals: [fm-aimed] }",
  ].join("\n"),
  "/fake/moose.config.yaml",
);

function target(suite: string): GraderTarget {
  const content = `---\ntitle: x\neval-suite: ${suite}\n---\nBody.`;
  const page: PageFile = {
    file: "docs/page.md",
    absPath: "/fake/docs/page.md",
    content,
    body: stripFrontmatterBlock(content),
    frontmatter: extractFrontmatter(content, "markdown"),
  };
  const plan = resolvePage(page, CONFIG);
  return { plan, eval: plan.evals[0]! };
}

describe("tool:docmeta without options.schemas", () => {
  it("reports a finding naming the missing option", async () => {
    const findings = await docmetaGrader.grade({
      targets: [target("bare")],
      config: CONFIG,
      root: process.cwd(),
      exec: () => {
        throw new Error("tool:docmeta runs in-process; exec must not be called");
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/options\.schemas/);
    expect(findings[0]?.severity).toBe("error");
  });

  it("does not silently inherit docmeta's default schema set", async () => {
    // The failure mode this guards: 13/13 fixture pages failing
    // `google:okf:0.1` for a missing `type`, reported as if the pages were
    // wrong rather than the eval underspecified.
    const findings = await docmetaGrader.grade({
      targets: [target("bare")],
      config: CONFIG,
      root: process.cwd(),
      exec: () => {
        throw new Error("unreachable");
      },
    });
    for (const f of findings) expect(f.message).not.toMatch(/okf|seven-action/);
  });
});
