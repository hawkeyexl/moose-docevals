/**
 * Rewriting an inline citation comment in place (ADR 01046). The invariant:
 * only the characters between `cite:` and the comment's closing delimiter
 * change. Everything else in the file — the body, CRLF endings, a BOM, other
 * comments — is byte-identical afterwards, which is the first body edit this
 * codebase makes and the reason the test diffs whole files.
 */
import { describe, it, expect } from "vitest";
import { scanCiteComments } from "../../src/citations/comments.js";
import { rewriteInlineCitations, serializeInlineTokens } from "../../src/citations/inline-edit.js";

const HASH = "9f2c0a4b1d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

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

describe("rewriteInlineCitations", () => {
  it("mints in place: adds the hash and commit inside the comment only", () => {
    const before = "# T\n\n<!-- cite: src=a.sh:1-2 -->\nClaim.\n\nMore.\n";
    const after = rewriteInlineCitations(before, [
      { span: spanOf(before), entry: { src: "a.sh:1-2", sha256: HASH, commit: "4d1e7c0" } },
    ]);
    expect(after).toBe(`# T\n\n<!-- cite: src=a.sh:1-2 sha256=${HASH} commit=4d1e7c0 -->\nClaim.\n\nMore.\n`);
  });

  it("keeps the MDX syntax and surrounding spacing", () => {
    const before = "{/*  cite:  src=a.sh  */}\nClaim.\n";
    const after = rewriteInlineCitations(before, [
      { span: spanOf(before), entry: { src: "a.sh:9-10", sha256: HASH } },
    ]);
    expect(after).toBe(`{/*  cite:  src=a.sh:9-10 sha256=${HASH}  */}\nClaim.\n`);
  });

  it("leaves every byte outside the comments alone, CRLF and BOM included", () => {
    const before = `﻿---\r\ntitle: T\r\n---\r\n<!-- cite: src=a.sh:1-2 sha256=${HASH} -->\r\nClaim.\r\n<!-- cite: other -->\r\nX.\r\n`;
    const after = rewriteInlineCitations(before, [
      { span: spanOf(before), entry: { src: "a.sh:3-4", sha256: HASH } },
    ]);
    expect(after).toBe(`﻿---\r\ntitle: T\r\n---\r\n<!-- cite: src=a.sh:3-4 sha256=${HASH} -->\r\nClaim.\r\n<!-- cite: other -->\r\nX.\r\n`);
  });

  it("applies several edits without one shifting the next", () => {
    const before = "<!-- cite: src=a.sh -->\nA.\n<!-- cite: src=b.sh -->\nB.\n";
    const spans = scanCiteComments(before).map((c) => c.span);
    const after = rewriteInlineCitations(before, [
      { span: spans[0]!, entry: { src: "a.sh", sha256: HASH } },
      { span: spans[1]!, entry: { src: "b.sh", sha256: HASH } },
    ]);
    expect(after).toBe(`<!-- cite: src=a.sh sha256=${HASH} -->\nA.\n<!-- cite: src=b.sh sha256=${HASH} -->\nB.\n`);
    // And the result still scans as two inline citations.
    expect(scanCiteComments(after).map((c) => c.kind)).toEqual(["inline", "inline"]);
  });
});
