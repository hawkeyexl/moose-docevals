/**
 * Rewriting an inline citation comment in place (ADR 01046). The invariant:
 * only the tokens that change, change. A value is replaced where it stands, a
 * new `sha256` or `commit` is inserted after the token it belongs beside, and
 * every other token, its order, and the spacing between tokens survive, as
 * does every byte of the file outside the comment: the body, CRLF endings, a
 * BOM, other comments. This is the first body edit this codebase makes, which
 * is why the test diffs whole files.
 *
 * The first version re-serialized the whole comment in a fixed order. That
 * dropped an explicit `quote=false` and reordered an author's tokens, both
 * of which are "something else changed" (PR 29 review).
 */
import { describe, it, expect } from "vitest";
import { scanCiteComments } from "../../src/citations/comments.js";
import {
  rewriteInlineCitations,
  serializeInlineTokens,
  updateInlineTokens,
} from "../../src/citations/inline-edit.js";

const HASH = "9f2c0a4b1d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";
const OTHER = "0".repeat(64);

function spanOf(content: string, index = 0) {
  const c = scanCiteComments(content)[index];
  if (!c) throw new Error("no comment");
  return c.span;
}

describe("serializeInlineTokens", () => {
  it("writes the fields in a fixed order, with quote as a bare flag", () => {
    expect(
      serializeInlineTokens({ id: "x", src: "a.sh:1-2", sha256: HASH, commit: "4d1e7c0", quote: true }),
    ).toBe(`id=x src=a.sh:1-2 sha256=${HASH} commit=4d1e7c0 quote`);
  });

  it("omits absent fields and a false quote", () => {
    expect(serializeInlineTokens({ src: "a.sh", quote: false })).toBe("src=a.sh");
  });
});

describe("updateInlineTokens", () => {
  it("inserts sha256 after src, and commit after sha256", () => {
    expect(updateInlineTokens("src=a.sh:1-2", { sha256: HASH, commit: "4d1e7c0" })).toBe(
      `src=a.sh:1-2 sha256=${HASH} commit=4d1e7c0`,
    );
  });

  it("replaces a value where it stands", () => {
    expect(updateInlineTokens(`src=a.sh:1-2 sha256=${HASH}`, { src: "a.sh:9-10" })).toBe(
      `src=a.sh:9-10 sha256=${HASH}`,
    );
    expect(updateInlineTokens(`src=a.sh sha256=${HASH} commit=aaaaaaa`, { sha256: OTHER, commit: "bbbbbbb" })).toBe(
      `src=a.sh sha256=${OTHER} commit=bbbbbbb`,
    );
  });

  it("keeps the author's token order", () => {
    expect(updateInlineTokens(`quote sha256=${HASH} id=x src=a.sh:1-2`, { src: "a.sh:3-4" })).toBe(
      `quote sha256=${HASH} id=x src=a.sh:3-4`,
    );
  });

  it("keeps an explicit quote=false, which a re-serialization would drop", () => {
    expect(updateInlineTokens("src=a.sh quote=false", { sha256: HASH })).toBe(
      `src=a.sh sha256=${HASH} quote=false`,
    );
  });

  it("keeps the spacing between tokens it does not touch", () => {
    expect(updateInlineTokens("id=x   src=a.sh    quote", { sha256: HASH })).toBe(
      `id=x   src=a.sh sha256=${HASH}    quote`,
    );
  });

  it("inserts a commit after src when there is no hash to sit beside", () => {
    expect(updateInlineTokens("src=a.sh quote", { commit: "4d1e7c0" })).toBe("src=a.sh commit=4d1e7c0 quote");
  });

  it("does not mistake a key that ends with the same letters", () => {
    // `xsrc=` is not `src=`; the schema rejects it elsewhere, but the editor
    // must not rewrite it.
    expect(updateInlineTokens("xsrc=b.sh src=a.sh", { src: "c.sh" })).toBe("xsrc=b.sh src=c.sh");
  });

  it("writes a value containing replacement metacharacters literally", () => {
    expect(updateInlineTokens("src=a.sh", { src: "https://x.io/$&/$1.txt:1-2" })).toBe(
      "src=https://x.io/$&/$1.txt:1-2",
    );
  });
});

describe("rewriteInlineCitations", () => {
  it("mints in place: adds the hash and commit inside the comment only", () => {
    const before = "# T\n\n<!-- cite: src=a.sh:1-2 -->\nClaim.\n\nMore.\n";
    const after = rewriteInlineCitations(before, [
      { span: spanOf(before), updates: { sha256: HASH, commit: "4d1e7c0" } },
    ]);
    expect(after).toBe(`# T\n\n<!-- cite: src=a.sh:1-2 sha256=${HASH} commit=4d1e7c0 -->\nClaim.\n\nMore.\n`);
  });

  it("keeps the MDX syntax and surrounding spacing", () => {
    const before = "{/*  cite:  src=a.sh  */}\nClaim.\n";
    const after = rewriteInlineCitations(before, [
      { span: spanOf(before), updates: { src: "a.sh:9-10", sha256: HASH } },
    ]);
    expect(after).toBe(`{/*  cite:  src=a.sh:9-10 sha256=${HASH}  */}\nClaim.\n`);
  });

  it("leaves every byte outside the comments alone, CRLF and BOM included", () => {
    const before = `﻿---\r\ntitle: T\r\n---\r\n<!-- cite: src=a.sh:1-2 sha256=${HASH} -->\r\nClaim.\r\n<!-- cite: other -->\r\nX.\r\n`;
    const after = rewriteInlineCitations(before, [{ span: spanOf(before), updates: { src: "a.sh:3-4" } }]);
    expect(after).toBe(
      `﻿---\r\ntitle: T\r\n---\r\n<!-- cite: src=a.sh:3-4 sha256=${HASH} -->\r\nClaim.\r\n<!-- cite: other -->\r\nX.\r\n`,
    );
  });

  it("applies several edits without one shifting the next", () => {
    const before = "<!-- cite: src=a.sh -->\nA.\n<!-- cite: src=b.sh -->\nB.\n";
    const spans = scanCiteComments(before).map((c) => c.span);
    const after = rewriteInlineCitations(before, [
      { span: spans[0]!, updates: { sha256: HASH } },
      { span: spans[1]!, updates: { sha256: HASH } },
    ]);
    expect(after).toBe(`<!-- cite: src=a.sh sha256=${HASH} -->\nA.\n<!-- cite: src=b.sh sha256=${HASH} -->\nB.\n`);
    expect(scanCiteComments(after).map((c) => c.kind)).toEqual(["inline", "inline"]);
  });
});
