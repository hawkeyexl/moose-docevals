/**
 * Integration: full pipeline (deterministic + judge) over the fixture corpus
 * with a scripted MockProvider — no live API, no cache reuse across tests.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runEvals } from "../../src/core/engine.js";
import { makeJudge } from "../../src/judge/judge.js";
import { MockProvider, mockVerdict } from "@hawkeyexl/inference";
import { parseConfig } from "../../src/core/config.js";
import { readFileSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "../..");

describe("full run with mock judge", () => {
  it("judges ai evals, keeps deterministic outcomes, and reports cost", async () => {
    // Cache dir isolated per test run.
    const cacheRoot = mkdtempSync(join(tmpdir(), "moose-docevals-e2e-"));
    const configText = readFileSync(join(ROOT, "moose.config.yaml"), "utf8");
    // The repo's own config file is already a complete moose config, so it
    // parses as-is rather than through the nesting helper.
    const config = parseConfig(
      configText.replace("cache-dir: .moose-docevals/cache", `cache-dir: ${JSON.stringify(join(cacheRoot, "cache"))}`),
      join(ROOT, "moose.config.yaml"),
    );

    const provider = new MockProvider([mockVerdict("pass", 0.95)]);
    const judge = makeJudge({ provider, root: ROOT });

    const report = await runEvals({
      cwd: ROOT,
      generate: false,
      judge: async (targets, _config, options) =>
        judge(targets, config, options),
    });

    const byKey = new Map(
      report.evalResults.map((r) => [`${r.file} ${r.evalName}`, r] as const),
    );

    // AI evals judged with consensus attached.
    const judged = byKey.get(
      "test/fixtures/pages/docs/get-started/concepts.md defines-core-terms",
    );
    expect(judged?.outcome).toBe("pass");
    expect(judged?.consensus?.zone).toBe("auto-pass");
    expect(judged?.consensus?.runs).toHaveLength(3);

    // Deterministic outcomes unchanged.
    expect(
      byKey.get("test/fixtures/pages/docs/actions/goTo.mdx fresh-enough")?.outcome,
    ).toBe("fail");

    // Cost accounting present (mock usage tokens counted).
    expect(report.cost.judgedEvals).toBeGreaterThan(5);
    expect(report.cost.totalTokens).toBeGreaterThan(0);

    // Suite summaries include judged results.
    const tutorial = report.suites.find((s) => s.suite === "tutorial");
    expect(tutorial?.passed).toBeGreaterThan(0);
    expect(tutorial?.meetsTarget).toBe(true);
  }, 60000);
});
