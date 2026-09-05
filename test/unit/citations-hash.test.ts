/**
 * The citation hashing rule and the `src` grammar (ADR 01045).
 *
 * The rule is stated once, in `src/citations/hash.ts`, and every minting and
 * checking path goes through it. These cases pin the parts that would make
 * the same bytes hash differently on two machines — a BOM, CRLF line endings,
 * a trailing newline — and the parts that would make two people disagree
 * about which lines "3-4" means.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  formatSrc,
  hashLines,
  hashRange,
  normalizeLines,
  parseSrc,
  sliceRange,
} from "../../src/citations/hash.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("normalizeLines", () => {
  it("splits on LF and drops the final empty element a trailing newline leaves", () => {
    expect(normalizeLines("a\nb\n")).toEqual(["a", "b"]);
    expect(normalizeLines("a\nb")).toEqual(["a", "b"]);
  });

  it("treats CRLF as LF, so a Windows checkout hashes like a Unix one", () => {
    expect(normalizeLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("strips a byte-order mark", () => {
    expect(normalizeLines("\uFEFFa\nb")).toEqual(["a", "b"]);
  });

  it("preserves trailing whitespace on a line — it is part of the bytes", () => {
    expect(normalizeLines("a  \nb\t\n")).toEqual(["a  ", "b\t"]);
  });

  it("keeps interior blank lines, since they change line numbers", () => {
    expect(normalizeLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("reads an empty file as one empty line", () => {
    expect(normalizeLines("")).toEqual([""]);
  });
});

describe("sliceRange", () => {
  const lines = ["one", "two", "three", "four"];

  it("is 1-based and inclusive", () => {
    expect(sliceRange(lines, { start: 2, end: 3 })).toEqual(["two", "three"]);
  });

  it("selects a single line when start equals end", () => {
    expect(sliceRange(lines, { start: 4, end: 4 })).toEqual(["four"]);
  });

  it("returns every line with no range", () => {
    expect(sliceRange(lines)).toEqual(lines);
  });

  it("returns undefined for a range past the end of the file, never a shorter slice", () => {
    expect(sliceRange(lines, { start: 3, end: 9 })).toBeUndefined();
    expect(sliceRange(lines, { start: 5, end: 5 })).toBeUndefined();
  });
});

describe("hashLines / hashRange", () => {
  it("joins with LF and no trailing newline", () => {
    expect(hashLines(["a", "b"])).toBe(sha("a\nb"));
  });

  it("hashes a range of a CRLF file identically to the same range of an LF file", () => {
    const range = { start: 2, end: 3 };
    expect(hashRange("x\r\na\r\nb\r\ny\r\n", range)).toBe(hashRange("x\na\nb\ny\n", range));
    expect(hashRange("x\na\nb\ny\n", range)).toBe(sha("a\nb"));
  });

  it("hashes the whole file under the same rule when no range is given", () => {
    expect(hashRange("\uFEFFa\r\nb\r\n")).toBe(sha("a\nb"));
  });

  it("is undefined when the range is beyond the file", () => {
    expect(hashRange("a\nb\n", { start: 3, end: 3 })).toBeUndefined();
  });
});

describe("parseSrc", () => {
  it("parses a relative path with a line range", () => {
    expect(parseSrc("scripts/install.sh:3-4")).toEqual({
      ok: true,
      spec: { kind: "file", path: "scripts/install.sh", range: { start: 3, end: 4 } },
    });
  });

  it("parses a single line as a one-line range", () => {
    expect(parseSrc("scripts/install.sh:7")).toEqual({
      ok: true,
      spec: { kind: "file", path: "scripts/install.sh", range: { start: 7, end: 7 } },
    });
  });

  it("parses a bare path as the whole file", () => {
    expect(parseSrc("CHANGELOG.md")).toEqual({
      ok: true,
      spec: { kind: "file", path: "CHANGELOG.md" },
    });
  });

  it("accepts an absolute path", () => {
    const result = parseSrc("/srv/shared/spec.md:10-20");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.kind).toBe("file");
      expect(result.spec.range).toEqual({ start: 10, end: 20 });
    }
  });

  it("does not read a Windows drive letter as a line range", () => {
    const result = parseSrc("C:/repo/spec.md:2");
    expect(result.ok).toBe(true);
    if (result.ok && result.spec.kind === "file") {
      expect(result.spec.path).toBe("C:/repo/spec.md");
      expect(result.spec.range).toEqual({ start: 2, end: 2 });
    }
  });

  it("parses a GitHub blob URL, rewriting it to the raw file and reading #L ranges", () => {
    expect(parseSrc("https://github.com/o/r/blob/main/src/x.ts#L3-L9")).toEqual({
      ok: true,
      spec: {
        kind: "url",
        url: "https://github.com/o/r/blob/main/src/x.ts",
        fetchUrl: "https://raw.githubusercontent.com/o/r/main/src/x.ts",
        github: { owner: "o", repo: "r", ref: "main", path: "src/x.ts" },
        range: { start: 3, end: 9 },
      },
    });
  });

  it("reads a single #L on a GitHub URL", () => {
    const result = parseSrc("https://github.com/o/r/blob/v1.2/README.md#L12");
    expect(result.ok && result.spec.range).toEqual({ start: 12, end: 12 });
  });

  it("parses any other https URL with a :L1-L2 suffix", () => {
    expect(parseSrc("https://example.com/spec.txt:5-9")).toEqual({
      ok: true,
      spec: {
        kind: "url",
        url: "https://example.com/spec.txt",
        fetchUrl: "https://example.com/spec.txt",
        range: { start: 5, end: 9 },
      },
    });
  });

  it("does not read a port as a line range", () => {
    const result = parseSrc("https://example.com:8080/spec.txt");
    expect(result.ok && result.spec.kind === "url" && result.spec.fetchUrl).toBe(
      "https://example.com:8080/spec.txt",
    );
    expect(result.ok && result.spec.range).toBeUndefined();
  });

  it("rejects an empty range, a reversed range, and a zero line", () => {
    expect(parseSrc("a.txt:0").ok).toBe(false);
    expect(parseSrc("a.txt:5-3").ok).toBe(false);
    expect(parseSrc("").ok).toBe(false);
  });

  it("rejects a non-https URL, which cannot be fetched", () => {
    expect(parseSrc("ftp://example.com/x").ok).toBe(false);
    expect(parseSrc("http://example.com/x").ok).toBe(false);
  });
});

describe("formatSrc", () => {
  it("round-trips every form, which is what `cite refresh` rewrites", () => {
    for (const src of [
      "scripts/install.sh:3-4",
      "scripts/install.sh:7",
      "CHANGELOG.md",
      "https://github.com/o/r/blob/main/src/x.ts#L3-L9",
      "https://github.com/o/r/blob/main/src/x.ts#L3",
      "https://example.com/spec.txt:5-9",
      "https://example.com/spec.txt",
    ]) {
      const parsed = parseSrc(src);
      expect(parsed.ok, src).toBe(true);
      if (parsed.ok) expect(formatSrc(parsed.spec)).toBe(src);
    }
  });

  it("formats a rewritten range", () => {
    const parsed = parseSrc("scripts/install.sh:3-4");
    if (!parsed.ok) throw new Error("parse failed");
    expect(formatSrc({ ...parsed.spec, range: { start: 9, end: 10 } })).toBe(
      "scripts/install.sh:9-10",
    );
  });
});
