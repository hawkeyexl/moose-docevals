import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFill, runFill } from "../../src/commands/fill.js";
import { MockProvider } from "@hawkeyexl/inference";
import { readPage } from "../../src/core/discover.js";
import { resolvePage } from "../../src/core/resolve.js";
import { loadConfig } from "../../src/core/config.js";
import { nestUnderDocevals } from "../helpers/config.js";

const BASE_CONFIG = 'version: 1\nfiles:\n  include: ["docs/**/*.md"]\n';

const PLAIN_PAGE = ["---", "title: Sample", "---", "", "# Heading", "", "Body.", ""].join("\n");

function workspace(pages: Record<string, string>, config = BASE_CONFIG): string {
  const root = mkdtempSync(join(tmpdir(), "moose-docevals-fill-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const [name, content] of Object.entries(pages)) {
    writeFileSync(join(root, "docs", name), content);
  }
  writeFileSync(join(root, "moose.config.yaml"), nestUnderDocevals(config));
  return root;
}

function proposal(id: string, confidence: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    assertion: `Assertion for ${id}.`,
    confidence,
    examples: { pass: "The page satisfies it.", fail: "The page violates it." },
    ...extra,
  };
}

describe("runFill", () => {
  it("writes proposals at or above the threshold and reports the rest", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([
      { json: { evals: [proposal("strong-check", 0.9), proposal("weak-check", 0.6)] } },
    ]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });

    expect(report.exitCode).toBe(0);
    expect(report.threshold).toBe(0.7);
    const [result] = report.results;
    expect(result?.status).toBe("filled");
    expect(result?.written.map((p) => p.id)).toEqual(["strong-check"]);
    expect(result?.belowThreshold.map((p) => p.id)).toEqual(["weak-check"]);

    const content = readFileSync(join(root, "docs", "page.md"), "utf8");
    expect(content).toContain("strong-check");
    expect(content).not.toContain("weak-check");
    expect(content.endsWith("Body.\n")).toBe(true);

    // The written page resolves cleanly: explicit grader/type, examples present.
    const plan = resolvePage(readPage(join(root, "docs", "page.md"), root), loadConfig(undefined, root));
    expect(plan.problems).toEqual([]);
    const ev = plan.evals.find((e) => e.name === "strong-check");
    expect(ev?.grader).toBe("ai");
    expect(ev?.type).toBe("regression");
    // Anchor examples normalize to lists: the vocabulary accepts one or
    // several, and the judge prompt should not have to branch on which.
    expect(ev?.examples).toEqual({
      pass: ["The page satisfies it."],
      fail: ["The page violates it."],
    });
  });

  it("writes a proposal at exactly the threshold", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([{ json: { evals: [proposal("edge-check", 0.7)] } }]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.written.map((p) => p.id)).toEqual(["edge-check"]);
  });

  it("honors a confidence override", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([
      { json: { evals: [proposal("strong-check", 0.9), proposal("weak-check", 0.6)] } },
    ]);
    const report = await runFill([], {
      cwd: root,
      providerInstance: provider,
      noCache: true,
      confidence: 0.5,
    });
    expect(report.threshold).toBe(0.5);
    expect(report.results[0]?.written.map((p) => p.id)).toEqual([
      "strong-check",
      "weak-check",
    ]);
  });

  it("drops proposals that duplicate inline or suite-referenced evals", async () => {
    const config = [
      "version: 1",
      "files:",
      '  include: ["docs/**/*.md"]',
      "evals:",
      "  suite-eval:",
      "    assertion: Suite level assertion.",
      "suites:",
      "  ref:",
      "    evals: [suite-eval]",
      "",
    ].join("\n");
    const page = [
      "---",
      "eval-suite: ref",
      "evals:",
      "  - id: inline-check",
      "    assertion: Inline assertion.",
      "    examples: { pass: P, fail: F }",
      "---",
      "body",
      "",
    ].join("\n");
    const root = workspace({ "page.md": page }, config);
    const provider = new MockProvider([
      {
        json: {
          evals: [
            proposal("inline-check", 0.9),
            proposal("suite-eval", 0.9),
            proposal("fresh-one", 0.9),
          ],
        },
      },
    ]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    const [result] = report.results;
    expect(result?.duplicates).toEqual(["inline-check", "suite-eval"]);
    expect(result?.written.map((p) => p.id)).toEqual(["fresh-one"]);
    const content = readFileSync(join(root, "docs", "page.md"), "utf8");
    expect(content.match(/inline-check/g)).toHaveLength(1);
  });

  it("leaves files untouched in dry-run mode", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([{ json: { evals: [proposal("strong-check", 0.9)] } }]);
    const report = await runFill([], {
      cwd: root,
      providerInstance: provider,
      noCache: true,
      dryRun: true,
    });
    expect(report.results[0]?.status).toBe("proposed");
    expect(report.results[0]?.written.map((p) => p.id)).toEqual(["strong-check"]);
    expect(readFileSync(join(root, "docs", "page.md"), "utf8")).toBe(PLAIN_PAGE);
  });

  it("serves repeat runs from the cache and re-asks with noCache", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([{ json: { evals: [proposal("strong-check", 0.9)] } }]);
    const opts = { cwd: root, providerInstance: provider, dryRun: true };

    const first = await runFill([], opts);
    expect(provider.requests).toHaveLength(1);
    expect(first.results[0]?.cached).toBe(false);

    const second = await runFill([], opts);
    expect(provider.requests).toHaveLength(1);
    expect(second.results[0]?.cached).toBe(true);
    expect(second.results[0]?.written.map((p) => p.id)).toEqual(["strong-check"]);

    await runFill([], { ...opts, noCache: true });
    expect(provider.requests).toHaveLength(2);
  });

  it("skips uncached pages once the cost budget is exhausted", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([{ json: { evals: [proposal("strong-check", 0.9)] } }]);
    const report = await runFill([], {
      cwd: root,
      providerInstance: provider,
      noCache: true,
      maxCost: 0,
    });
    expect(report.results[0]?.status).toBe("skipped-budget");
    expect(provider.requests).toHaveLength(0);
    expect(report.exitCode).toBe(0);
  });

  it("contains per-page provider failures without aborting the run", async () => {
    const root = workspace({ "a.md": PLAIN_PAGE, "b.md": PLAIN_PAGE });
    const provider = new MockProvider([
      { error: "boom" },
      { json: { evals: [proposal("strong-check", 0.9)] } },
    ]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results.map((r) => r.status)).toEqual(["error", "filled"]);
    expect(report.results[0]?.error).toMatch(/boom/);
    expect(report.exitCode).toBe(1);
  });

  it("treats a schema-invalid proposal as a page error", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([{ json: { bogus: true } }]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.status).toBe("error");
    expect(report.exitCode).toBe(1);
  });

  it("skips pages with eval-skip without calling the provider", async () => {
    const page = ["---", "eval-skip: true", "---", "body", ""].join("\n");
    const root = workspace({ "page.md": page });
    const provider = new MockProvider([{ json: { evals: [] } }]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.status).toBe("skipped");
    expect(provider.requests).toHaveLength(0);
  });

  it("truncates proposals to maxEvalsPerPage", async () => {
    const config = `${BASE_CONFIG}fill:\n  max-evals-per-page: 1\n`;
    const root = workspace({ "page.md": PLAIN_PAGE }, config);
    const provider = new MockProvider([
      { json: { evals: [proposal("first-check", 0.9), proposal("second-check", 0.9)] } },
    ]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.written.map((p) => p.id)).toEqual(["first-check"]);
    // Proposals over the cap are surfaced, not silently dropped.
    expect(report.results[0]?.capped.map((p) => p.id)).toEqual(["second-check"]);
  });

  it("does not let duplicates consume the per-page cap", async () => {
    // maxEvalsPerPage 1, and the model leads with a duplicate of an existing
    // eval. The duplicate must not crowd out the fresh proposal behind it.
    const config = `${BASE_CONFIG}fill:\n  max-evals-per-page: 1\n`;
    const page = [
      "---",
      "evals:",
      "  - id: existing-check",
      "    assertion: Already here.",
      "    examples: { pass: P, fail: F }",
      "---",
      "body",
      "",
    ].join("\n");
    const root = workspace({ "page.md": page }, config);
    const provider = new MockProvider([
      { json: { evals: [proposal("existing-check", 0.9), proposal("fresh-one", 0.9)] } },
    ]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.duplicates).toEqual(["existing-check"]);
    expect(report.results[0]?.written.map((p) => p.id)).toEqual(["fresh-one"]);
  });

  it("reports nothing-proposed when the model proposes nothing", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([{ json: { evals: [] } }]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.status).toBe("nothing-proposed");
    expect(report.exitCode).toBe(0);
  });

  it("renders human and json reports", async () => {
    const root = workspace({ "page.md": PLAIN_PAGE });
    const provider = new MockProvider([
      { json: { evals: [proposal("strong-check", 0.9), proposal("weak-check", 0.6)] } },
    ]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });

    const human = renderFill(report, "human");
    expect(human).toContain("filled");
    expect(human).toContain("docs/page.md");
    expect(human).toContain("strong-check 0.90");
    expect(human).toContain("below 0.7: weak-check 0.60");
    expect(human).toContain("Threshold: 0.7");
    expect(human).toMatch(/LLM cost: \$\d+\.\d{4}/);

    const json = JSON.parse(renderFill(report, "json")) as typeof report;
    expect(json.results[0]?.written[0]?.id).toBe("strong-check");
    expect(json.exitCode).toBe(0);
  });

  it("treats non-YAML frontmatter as a contained page error", async () => {
    const toml = ["+++", 'title = "Sample"', "+++", "body", ""].join("\n");
    const root = workspace({ "page.md": toml });
    const provider = new MockProvider([{ json: { evals: [proposal("x-check", 0.9)] } }]);
    const report = await runFill([], { cwd: root, providerInstance: provider, noCache: true });
    expect(report.results[0]?.status).toBe("error");
    expect(report.results[0]?.error).toMatch(/YAML/i);
    expect(readFileSync(join(root, "docs", "page.md"), "utf8")).toBe(toml);
    expect(report.exitCode).toBe(1);
  });
});
