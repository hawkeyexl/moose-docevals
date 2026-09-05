/**
 * The body side of a citation (ADR 01045): a comment that either *refers to*
 * a frontmatter entry by id, or *is* the citation, written as `key=value`
 * tokens. Both anchor a sentence — the claim — so a finding can point at the
 * line and quote the sentence without frontmatter carrying it.
 *
 * What these cases pin: both comment syntaxes (an HTML comment for Markdown,
 * a JSX comment for MDX, which forbids HTML comments), reference-versus-inline detection,
 * where the claim is read from, exact character spans (which `cite refresh`
 * rewrites in place), and the two places a comment must be *ignored* — inside
 * a fenced code block and inside an inline code span — because a page that
 * documents the syntax would otherwise declare citations it never meant.
 */
import { describe, it, expect } from "vitest";
import {
  fencedBlockAfter,
  parseInlineTokens,
  scanCiteComments,
} from "../../src/citations/comments.js";

describe("scanCiteComments", () => {
  it("reads an HTML reference comment and the sentence on the next line as the claim", () => {
    const content = "# Title\n\n<!-- cite: node-floor -->\nThe installer needs Node 22.\n";
    const [c] = scanCiteComments(content);
    expect(c).toMatchObject({
      kind: "reference",
      id: "node-floor",
      line: 3,
      syntax: "html",
      claim: "The installer needs Node 22.",
      claimLine: 4,
    });
  });

  it("reads an MDX comment", () => {
    const content = "{/* cite: node-floor */}\nThe installer needs Node 22.\n";
    const [c] = scanCiteComments(content);
    expect(c).toMatchObject({ kind: "reference", id: "node-floor", syntax: "mdx", line: 1 });
  });

  it("reads the same-line text as the claim when the comment ends a sentence", () => {
    const content = "The installer needs Node 22. <!-- cite: node-floor -->\nUnrelated.\n";
    const [c] = scanCiteComments(content);
    expect(c?.claim).toBe("The installer needs Node 22.");
    expect(c?.claimLine).toBe(1);
  });

  it("skips blank lines to find the claim", () => {
    const content = "<!-- cite: x -->\n\n\nThe claim.\n";
    expect(scanCiteComments(content)[0]?.claim).toBe("The claim.");
    expect(scanCiteComments(content)[0]?.claimLine).toBe(4);
  });

  it("has an empty claim when the comment is followed by a code fence", () => {
    const content = "<!-- cite: x -->\n```bash\nnpm i\n```\n";
    expect(scanCiteComments(content)[0]?.claim).toBe("");
  });

  it("parses an inline citation into the frontmatter entry shape", () => {
    const content =
      "<!-- cite: src=scripts/install.sh:3-4 sha256=abc commit=4d1e7c0 id=node-floor quote -->\nClaim.\n";
    const [c] = scanCiteComments(content);
    expect(c).toMatchObject({
      kind: "inline",
      entry: {
        src: "scripts/install.sh:3-4",
        sha256: "abc",
        commit: "4d1e7c0",
        id: "node-floor",
        quote: true,
      },
    });
  });

  it("parses an unminted inline citation: a src and nothing else", () => {
    const [c] = scanCiteComments("<!-- cite: src=CHANGELOG.md -->\nClaim.\n");
    expect(c).toMatchObject({ kind: "inline", entry: { src: "CHANGELOG.md" } });
  });

  it("records the span of the token text so a rewrite touches only that", () => {
    const content = "intro\n<!--  cite: src=a.txt:1  -->\nClaim.\n";
    const [c] = scanCiteComments(content);
    expect(c && content.slice(c.span.start, c.span.end)).toBe("src=a.txt:1");
  });

  it("records the span for the MDX form too", () => {
    const content = "{/* cite: node-floor */}\n";
    const [c] = scanCiteComments(content);
    expect(c && content.slice(c.span.start, c.span.end)).toBe("node-floor");
  });

  it("counts lines correctly in a CRLF file", () => {
    const content = "a\r\nb\r\n<!-- cite: x -->\r\nClaim.\r\n";
    const [c] = scanCiteComments(content);
    expect(c?.line).toBe(3);
    expect(c?.claim).toBe("Claim.");
  });

  it("reports a comment that is neither a reference nor key=value tokens", () => {
    const [c] = scanCiteComments("<!-- cite: two words -->\n");
    expect(c?.kind).toBe("invalid");
  });

  it("reports a reference that is not kebab-case", () => {
    const [c] = scanCiteComments("<!-- cite: Not_Kebab -->\n");
    expect(c?.kind).toBe("invalid");
  });

  it("ignores comments inside a fenced code block", () => {
    const content = [
      "Write this above the sentence:",
      "",
      "```markdown",
      "<!-- cite: src=scripts/install.sh:3-4 -->",
      "The installer needs Node 22.",
      "```",
      "",
      "<!-- cite: real -->",
      "A real one.",
      "",
    ].join("\n");
    const found = scanCiteComments(content);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "reference", id: "real", line: 8 });
  });

  it("ignores comments inside an inline code span", () => {
    const content = "Write `<!-- cite: node-floor -->` above the sentence.\n";
    expect(scanCiteComments(content)).toHaveLength(0);
  });

  it("finds several comments on a page in order", () => {
    const content = "<!-- cite: a -->\nA.\n\n<!-- cite: b -->\nB.\n";
    expect(scanCiteComments(content).map((c) => c.kind === "reference" && c.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("parseInlineTokens", () => {
  it("accepts quote as a bare flag or as quote=true/false", () => {
    expect(parseInlineTokens(["src=a", "quote"])).toEqual({
      ok: true,
      entry: { src: "a", quote: true },
    });
    expect(parseInlineTokens(["src=a", "quote=false"])).toEqual({
      ok: true,
      entry: { src: "a", quote: false },
    });
  });

  it("keeps unknown keys so the shared schema definition rejects them", () => {
    expect(parseInlineTokens(["src=a", "claim=x"])).toEqual({
      ok: true,
      entry: { src: "a", claim: "x" },
    });
  });

  it("rejects a bare token other than quote", () => {
    expect(parseInlineTokens(["src=a", "current"]).ok).toBe(false);
  });

  it("rejects a repeated key", () => {
    expect(parseInlineTokens(["src=a", "src=b"]).ok).toBe(false);
  });

  it("keeps an = inside a value", () => {
    expect(parseInlineTokens(["src=https://x.io/f?a=b:1-2"])).toEqual({
      ok: true,
      entry: { src: "https://x.io/f?a=b:1-2" },
    });
  });
});

describe("fencedBlockAfter", () => {
  const lines = [
    "<!-- cite: x -->",
    "The check is:",
    "",
    "```bash",
    "line one",
    "line two",
    "```",
    "after",
  ];

  it("returns the first fenced block's content and the fence line", () => {
    expect(fencedBlockAfter(lines, 1, lines.length)).toEqual({
      text: "line one\nline two",
      line: 4,
    });
  });

  it("stops looking at the bound", () => {
    expect(fencedBlockAfter(lines, 1, 3)).toBeUndefined();
  });

  it("returns undefined for an unterminated fence", () => {
    expect(fencedBlockAfter(["```", "x"], 0, 2)).toBeUndefined();
  });

  it("closes only on a fence of the same character and at least the same length", () => {
    expect(fencedBlockAfter(["````", "```", "inner", "````"], 0, 4)).toEqual({
      text: "```\ninner",
      line: 1,
    });
  });
});
