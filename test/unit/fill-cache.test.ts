import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FillCache, fillCacheKey } from "../../src/fill/cache.js";

const PROPOSAL = {
  evals: [
    {
      id: "has-overview",
      assertion: "The page opens with an overview.",
      confidence: 0.9,
      examples: { pass: "Overview present.", fail: "No overview." },
    },
  ],
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "moose-docevals-fill-cache-"));
}

describe("fillCacheKey", () => {
  const base = () =>
    fillCacheKey("anthropic", "claude-sonnet-4-5", 0, 3, "body", ["a"]);

  it("is stable for identical inputs", () => {
    expect(base()).toBe(base());
  });

  it("changes with any input", () => {
    expect(fillCacheKey("openai", "claude-sonnet-4-5", 0, 3, "body", ["a"])).not.toBe(base());
    expect(fillCacheKey("anthropic", "other-model", 0, 3, "body", ["a"])).not.toBe(base());
    expect(fillCacheKey("anthropic", "claude-sonnet-4-5", 1, 3, "body", ["a"])).not.toBe(base());
    expect(fillCacheKey("anthropic", "claude-sonnet-4-5", 0, 5, "body", ["a"])).not.toBe(base());
    expect(fillCacheKey("anthropic", "claude-sonnet-4-5", 0, 3, "other", ["a"])).not.toBe(base());
    expect(fillCacheKey("anthropic", "claude-sonnet-4-5", 0, 3, "body", ["a", "b"])).not.toBe(base());
  });
});

describe("FillCache", () => {
  it("round-trips a proposal", () => {
    const cache = new FillCache(tempDir());
    cache.set("key", PROPOSAL);
    expect(cache.get("key")).toEqual(PROPOSAL);
  });

  it("misses on unknown keys and corrupt entries", () => {
    const dir = tempDir();
    const cache = new FillCache(dir);
    expect(cache.get("missing")).toBeUndefined();
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(cache.get("bad")).toBeUndefined();
  });

  it("misses on entries that do not match the proposal schema", () => {
    const dir = tempDir();
    const cache = new FillCache(dir);
    writeFileSync(join(dir, "stale.json"), JSON.stringify({ shape: "wrong" }));
    expect(cache.get("stale")).toBeUndefined();
  });

  it("does nothing when disabled", () => {
    const dir = tempDir();
    const cache = new FillCache(dir, false);
    cache.set("key", PROPOSAL);
    expect(cache.get("key")).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
});
