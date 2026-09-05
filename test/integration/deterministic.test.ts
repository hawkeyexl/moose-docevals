/**
 * Integration: full deterministic pipeline over the fixture corpus, with the
 * real command grader running the pre-generated fixture script via node.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { runEvals } from "../../src/core/engine.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("deterministic run over fixtures", () => {
  it("produces the expected outcomes", async () => {
    const report = await runEvals({
      cwd: ROOT,
      deterministicOnly: true,
      generate: false,
    });

    expect(report.pages).toBe(13);
    const byKey = new Map(
      report.evalResults.map((r) => [`${r.file} ${r.evalName}`, r] as const),
    );

    // Pre-generated script runs and passes.
    expect(
      byKey.get("test/fixtures/pages/docs/actions/find.mdx has-examples-heading")
        ?.outcome,
    ).toBe("pass");

    // Severity-overridden freshness fails at error level.
    const goTo = byKey.get("test/fixtures/pages/docs/actions/goTo.mdx fresh-enough");
    expect(goTo?.outcome).toBe("fail");
    expect(goTo?.findings?.[0]?.ruleId).toBe("freshness/stale");

    // Warning-severity freshness passes but carries the finding.
    const concepts = byKey.get(
      "test/fixtures/pages/docs/get-started/concepts.md fresh-enough",
    );
    expect(concepts?.outcome).toBe("pass");
    expect(concepts?.findings?.[0]?.severity).toBe("warning");

    // Citations (ADR 01045). installation.mdx cites a range that moved: the
    // finding is info and the page passes. concepts.md cites a range that
    // changed and a file that is gone, at error severity, so it fails, and
    // its unminted inline citation and orphaned reference are reported too.
    const cited = byKey.get(
      "test/fixtures/pages/docs/get-started/installation.mdx cited-sources-current",
    );
    expect(cited?.outcome).toBe("pass");
    expect(cited?.findings?.map((f) => [f.ruleId, f.severity])).toEqual([
      ["citations/moved", "info"],
    ]);
    expect(cited?.findings?.[0]?.message).toContain("test/fixtures/cited/greeting.sh:7-10");
    const stale = byKey.get(
      "test/fixtures/pages/docs/get-started/concepts.md cited-sources-current",
    );
    expect(stale?.outcome).toBe("fail");
    expect(stale?.findings?.map((f) => f.ruleId).sort()).toEqual([
      "citations/changed",
      "citations/missing",
      "citations/reference-orphan",
      "citations/unminted",
    ]);

    // Missing command with generation disabled errors.
    expect(
      byKey.get(
        "test/fixtures/pages/docs/get-started/installation.mdx install-command-present",
      )?.outcome,
    ).toBe("error");

    // AI evals are skipped under --deterministic-only.
    expect(
      byKey.get("test/fixtures/pages/docs/get-started/concepts.md defines-core-terms")
        ?.outcome,
    ).toBe("skipped");

    // Per-page eval skip.
    expect(
      byKey.get("test/fixtures/pages/docs/tests/inline.mdx readable")?.outcome,
    ).toBe("skipped");

    // Suite summaries exist for configured suites; failures produce exit 1.
    expect(report.suites.map((s) => s.suite)).toContain("reference");
    expect(report.exitCode).toBe(1);
  }, 30000);

  it("skips frontmatter commands when disabled", async () => {
    const report = await runEvals({
      cwd: ROOT,
      deterministicOnly: true,
      generate: false,
      execution: false,
    });
    const finding = report.evalResults.find(
      (r) =>
        r.file === "test/fixtures/pages/docs/actions/find.mdx" &&
        r.evalName === "has-examples-heading",
    );
    expect(finding?.outcome).toBe("skipped");
    expect(finding?.skipReason).toMatch(/frontmatter commands not granted/);
  });
});
