/**
 * `init` scaffolds the config a new user starts from, so a mistake here is
 * invisible: a config the loader does not recognize yields a defaults-only run
 * with no named evals and no suites — and passes. These tests load what `init`
 * writes rather than matching its text.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../src/commands/init.js";
import { loadConfig } from "../../src/core/config.js";
import { DocevalsError } from "../../src/types.js";

const dir = () => mkdtempSync(join(tmpdir(), "moose-docevals-init-"));

describe("runInit", () => {
  it("writes moose.config.yaml", () => {
    const root = dir();
    const path = runInit(root);
    expect(basename(path)).toBe("moose.config.yaml");
    expect(existsSync(path)).toBe(true);
  });

  it("nests the starter config under the docevals namespace", () => {
    const root = dir();
    const text = readFileSync(runInit(root), "utf8");
    expect(text).toMatch(/^docevals:$/m);
  });

  // The whole point of the scaffold: what it writes must survive a round-trip
  // through the real loader with its evals and suites intact.
  it("scaffolds a config the loader reads back with its evals and suites", () => {
    const root = dir();
    runInit(root);
    const config = loadConfig(undefined, root);
    expect(Object.keys(config.evals)).toContain("no-future-promises");
    expect(config.suites.default?.evals).toContain("fresh-enough");
    expect(config.judge.ensembleRuns).toBe(3);
  });

  it("refuses to overwrite an existing config", () => {
    const root = dir();
    runInit(root);
    expect(() => runInit(root)).toThrow(DocevalsError);
  });
});
