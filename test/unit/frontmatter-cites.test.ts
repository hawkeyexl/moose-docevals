/**
 * The frontmatter side of `cite add` and `cite refresh` (ADR 01046):
 * appending `cites` entries and updating one in place. Same contract as
 * `appendPageEvals` — the body is byte-identical, CRLF survives, comments
 * and ordering elsewhere in the block survive — and every output is
 * validated against the published schema, so the writer can never emit a
 * page the reader rejects.
 */
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { appendPageCites, updatePageCite } from "../../src/core/frontmatter-edit.js";
import { frontmatterSchema } from "../../src/schema.js";
import { DocevalsError } from "../../src/types.js";

const PATH = "docs/page.md";
const HASH = "9f2c0a4b1d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(frontmatterSchema);

function frontmatterOf(content: string): Record<string, unknown> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  expect(match, "output has a frontmatter block").toBeTruthy();
  const data = parseYaml(match![1]!) as Record<string, unknown>;
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
  return data;
}

const cites = (data: Record<string, unknown>) => data.cites as Record<string, unknown>[];

describe("appendPageCites", () => {
  it("adds a cites list to an existing block, keeping the body and comments", () => {
    const page = ["---", "title: Page # keep me", "evals:", "  - use: x", "---", "", "# Body", ""].join("\n");
    const out = appendPageCites(page, PATH, [
      { id: "node-floor", src: "scripts/install.sh:3-4", sha256: HASH, commit: "4d1e7c0" },
    ]);
    expect(out).toContain("title: Page # keep me");
    expect(out.endsWith("---\n\n# Body\n")).toBe(true);
    expect(cites(frontmatterOf(out))).toEqual([
      { id: "node-floor", src: "scripts/install.sh:3-4", sha256: HASH, commit: "4d1e7c0" },
    ]);
  });

  it("appends to an existing list without touching earlier entries", () => {
    const page = ["---", "cites:", "  - id: a", "    src: a.sh", `    sha256: ${HASH}`, "---", "Body."].join("\n");
    const out = appendPageCites(page, PATH, [{ id: "b", src: "b.sh", sha256: HASH, quote: true }]);
    expect(cites(frontmatterOf(out)).map((c) => c.id)).toEqual(["a", "b"]);
    expect(cites(frontmatterOf(out))[1]).toEqual({ id: "b", src: "b.sh", sha256: HASH, quote: true });
  });

  it("synthesizes a block when the page has none", () => {
    const out = appendPageCites("# Body\n", PATH, [{ id: "a", src: "a.sh", sha256: HASH }]);
    expect(out.endsWith("---\n# Body\n")).toBe(true);
    expect(cites(frontmatterOf(out))).toHaveLength(1);
  });

  it("preserves CRLF line endings", () => {
    const page = "---\r\ntitle: T\r\n---\r\nBody.\r\n";
    const out = appendPageCites(page, PATH, [{ id: "a", src: "a.sh", sha256: HASH }]);
    expect(out).not.toMatch(/(?<!\r)\n/);
    expect(out.endsWith("---\r\nBody.\r\n")).toBe(true);
  });

  it("quotes an all-digit sha or commit, which YAML would otherwise read as a number", () => {
    const digits = "1".repeat(64);
    const out = appendPageCites("---\ntitle: T\n---\nBody.\n", PATH, [
      { id: "a", src: "a.sh", sha256: digits, commit: "1234567" },
    ]);
    const [entry] = cites(frontmatterOf(out));
    expect(entry?.sha256).toBe(digits);
    expect(entry?.commit).toBe("1234567");
    expect(typeof entry?.commit).toBe("string");
  });

  it("refuses a duplicate id", () => {
    const page = ["---", "cites:", "  - id: a", "    src: a.sh", "---", "Body."].join("\n");
    expect(() => appendPageCites(page, PATH, [{ id: "a", src: "b.sh" }])).toThrow(DocevalsError);
  });

  it("refuses non-YAML frontmatter", () => {
    expect(() => appendPageCites("+++\ntitle = 'T'\n+++\nBody.\n", PATH, [{ id: "a", src: "a.sh" }])).toThrow(
      /only YAML frontmatter/,
    );
  });

  it("refuses a cites key that is not a list", () => {
    expect(() => appendPageCites("---\ncites: nope\n---\nBody.\n", PATH, [{ id: "a", src: "a.sh" }])).toThrow(
      DocevalsError,
    );
  });
});

describe("updatePageCite", () => {
  const page = [
    "---",
    "title: T",
    "cites:",
    "  - id: a",
    "    src: a.sh:1-2",
    `    sha256: ${HASH}`,
    "    commit: 4d1e7c0",
    "  - id: b # keep",
    "    src: b.sh",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  it("rewrites the named entry's src and leaves the rest of the block alone", () => {
    const out = updatePageCite(page, PATH, "a", { src: "a.sh:9-10" });
    expect(cites(frontmatterOf(out))[0]).toEqual({ id: "a", src: "a.sh:9-10", sha256: HASH, commit: "4d1e7c0" });
    expect(out).toContain("  - id: b # keep");
    expect(out.endsWith("---\n\nBody.\n")).toBe(true);
  });

  it("mints an unminted entry by adding sha256 and commit", () => {
    const out = updatePageCite(page, PATH, "b", { sha256: HASH, commit: "abcdef0" });
    expect(cites(frontmatterOf(out))[1]).toEqual({ id: "b", src: "b.sh", sha256: HASH, commit: "abcdef0" });
  });

  it("re-mints: replaces the hash and commit together", () => {
    const out = updatePageCite(page, PATH, "a", { sha256: "0".repeat(64), commit: "1111111" });
    expect(cites(frontmatterOf(out))[0]).toMatchObject({ sha256: "0".repeat(64), commit: "1111111" });
  });

  it("errors when the id is not in the list", () => {
    expect(() => updatePageCite(page, PATH, "zzz", { src: "x" })).toThrow(/"zzz" not found/);
  });
});
