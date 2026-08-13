import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, loadConfig } from "../../src/core/config.js";
import { DocevalsError } from "../../src/types.js";

const PATH = "/fake/moose.config.yaml";

/**
 * Nest a docevals config body under the `docevals:` key of a moose config, so
 * the tests read as the settings they exercise rather than as YAML plumbing.
 */
function moose(...lines: string[]): string {
  return ["docevals:", ...lines.map((l) => (l === "" ? l : `  ${l}`))].join("\n") + "\n";
}

describe("parseConfig", () => {
  it("applies defaults for a minimal config", () => {
    const c = parseConfig(moose("version: 1"), PATH);
    expect(c.files.include).toEqual(["**/*.{md,mdx}"]);
    expect(c.defaults.concurrency).toBe(4);
    expect(c.provider.default).toBe("anthropic");
    expect(c.judge.ensembleRuns).toBe(3);
    expect(c.judge.temperature).toBe(0);
    expect(c.judge.zones).toEqual({ autoPass: 0.8, autoFail: 0.8 });
    expect(c.judge.falsePositiveAlert).toBe(0.15);
    expect(c.judge.cacheDir).toBe(".moose-docevals/cache");
    expect(c.scripts.allowFrontmatterCommands).toBe(true);
    expect(c.scripts.dir).toBe("{docDir}/moose-docevals");
    expect(c.scripts.configDir).toBe("moose-docevals-scripts");
    expect(c.evals).toEqual({});
    expect(c.suites).toEqual({});
  });

  it("ignores root keys belonging to other tools in the moose family", () => {
    const c = parseConfig(
      [
        "some-other-tool:",
        "  enabled: true",
        "  anything: { at: all }",
        "docevals:",
        "  version: 1",
        "  defaults:",
        "    concurrency: 9",
      ].join("\n"),
      PATH,
    );
    expect(c.defaults.concurrency).toBe(9);
  });

  it("falls back to defaults when the file configures only other tools", () => {
    const c = parseConfig("some-other-tool:\n  enabled: true\n", PATH);
    expect(c.version).toBe(1);
    expect(c.defaults.concurrency).toBe(4);
    expect(c.evals).toEqual({});
  });

  it("rejects invalid YAML", () => {
    expect(() => parseConfig("docevals: [1", PATH)).toThrow(DocevalsError);
  });

  it("rejects a non-object root", () => {
    expect(() => parseConfig("- a\n- b\n", PATH)).toThrow(/root must be an object/);
  });

  it("rejects unknown keys inside the docevals namespace", () => {
    expect(() => parseConfig(moose("version: 1", "runners: {}"), PATH)).toThrow(
      /Invalid config/,
    );
  });

  it("rejects a missing version", () => {
    expect(() => parseConfig(moose("files: {}"), PATH)).toThrow(/version/);
  });

  it("parses evals and suites, defaulting targetPassRate to 1.0", () => {
    const c = parseConfig(
      moose(
        "version: 1",
        "evals:",
        "  my-eval:",
        "    assertion: Something is true.",
        "suites:",
        "  ref:",
        "    evals: [my-eval]",
      ),
      PATH,
    );
    expect(c.suites.ref).toEqual({ targetPassRate: 1.0, evals: ["my-eval"] });
    expect(c.evals["my-eval"]?.assertion).toBe("Something is true.");
  });

  it("rejects a suite referencing an undefined eval", () => {
    expect(() =>
      parseConfig(moose("version: 1", "suites:", "  ref:", "    evals: [ghost]"), PATH),
    ).toThrow(/references undefined eval "ghost"/);
  });

  it("rejects an undefined defaults.suite", () => {
    expect(() =>
      parseConfig(moose("version: 1", "defaults:", "  suite: ghost"), PATH),
    ).toThrow(/defaults\.suite "ghost"/);
  });

  it("applies fill defaults for a minimal config", () => {
    const c = parseConfig(moose("version: 1"), PATH);
    expect(c.fill).toEqual({
      confidenceThreshold: 0.7,
      maxEvalsPerPage: 3,
      temperature: 0,
      cacheDir: ".moose-docevals/cache/fill",
      maxCostUsd: null,
    });
  });

  it("respects explicit fill values", () => {
    const c = parseConfig(
      moose(
        "version: 1",
        "fill:",
        "  confidenceThreshold: 0.9",
        "  maxEvalsPerPage: 1",
        "  temperature: 0.5",
        "  cacheDir: .cache/fill",
        "  maxCostUsd: 2",
      ),
      PATH,
    );
    expect(c.fill).toEqual({
      confidenceThreshold: 0.9,
      maxEvalsPerPage: 1,
      temperature: 0.5,
      cacheDir: ".cache/fill",
      maxCostUsd: 2,
    });
  });

  it("rejects unknown fill keys", () => {
    expect(() => parseConfig(moose("version: 1", "fill:", "  bogus: true"), PATH)).toThrow(
      /Invalid config/,
    );
  });

  it("rejects an out-of-range fill confidenceThreshold", () => {
    expect(() =>
      parseConfig(moose("version: 1", "fill:", "  confidenceThreshold: 1.5"), PATH),
    ).toThrow(/Invalid config/);
  });

  it("rejects invalid eval names", () => {
    expect(() =>
      parseConfig(moose("version: 1", "evals:", "  Bad_Name:", "    assertion: x"), PATH),
    ).toThrow(/Invalid config/);
  });
});

describe("loadConfig", () => {
  /** The pre-rename filename. Spelled out here so a rename sweep can't erase it. */
  const LEGACY = "docevals" + ".config.yaml";
  const dir = () => mkdtempSync(join(tmpdir(), "moose-docevals-config-"));

  it("discovers moose.config.yaml in the working directory", () => {
    const root = dir();
    writeFileSync(join(root, "moose.config.yaml"), moose("version: 1", "defaults:", "  concurrency: 7"));
    expect(loadConfig(undefined, root).defaults.concurrency).toBe(7);
  });

  it("returns built-in defaults when no config file is present", () => {
    const c = loadConfig(undefined, dir());
    expect(c.version).toBe(1);
    expect(c.evals).toEqual({});
  });

  // A legacy file must not fall through to defaults: that would run with no
  // named evals and no suites, and silently pass.
  it("errors on a legacy docevals.config.yaml instead of ignoring it", () => {
    const root = dir();
    writeFileSync(join(root, LEGACY), "version: 1\n");
    expect(() => loadConfig(undefined, root)).toThrow(DocevalsError);
    expect(() => loadConfig(undefined, root)).toThrow(/moose\.config\.yaml/);
  });

  it("prefers moose.config.yaml when a legacy file sits beside it", () => {
    const root = dir();
    writeFileSync(join(root, LEGACY), "version: 1\n");
    writeFileSync(
      join(root, "moose.config.yaml"),
      moose("version: 1", "defaults:", "  concurrency: 5"),
    );
    expect(loadConfig(undefined, root).defaults.concurrency).toBe(5);
  });
});
