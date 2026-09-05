/**
 * `resolvePage` normalizes both citation forms — frontmatter `cites` entries
 * and inline body comments — into one list, so the grader and `cite refresh`
 * never learn which form a citation came from (ADR 01045).
 *
 * The page problems pinned here are the loud-typo class: a duplicate id, an
 * inline entry with a misspelled field (rejected by the *same* schema
 * definition the frontmatter list uses), a `cite-` key that is not
 * `cite-commit`, and a page that declares citations no eval checks.
 */
import { describe, it, expect } from "vitest";
import { extractFrontmatter } from "docmeta";
import { parseDocevalsConfig } from "../helpers/config.js";
import { stripFrontmatterBlock, type PageFile } from "../../src/core/discover.js";
import { resolvePage } from "../../src/core/resolve.js";

const CONFIG = parseDocevalsConfig(`version: 1
evals:
  cited-sources-current:
    assertion: Every cited source range still matches the page.
    grader: tool:citations
    severity: warning
`);

const HASH = "9f2c0a4b1d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

function page(frontmatter: string, body: string, file = "docs/page.md"): PageFile {
  const content = `---\n${frontmatter}\n---\n${body}`;
  return {
    file,
    absPath: `/fake/${file}`,
    content,
    body: stripFrontmatterBlock(content),
    frontmatter: extractFrontmatter(content, file.endsWith(".mdx") ? "mdx" : "markdown"),
  };
}

const CHECKED = "evals:\n  - use: cited-sources-current";

describe("resolvePage: citations", () => {
  it("resolves a frontmatter entry and anchors it to its reference comment", () => {
    const plan = resolvePage(
      page(
        `${CHECKED}\ncites:\n  - id: node-floor\n    src: scripts/install.sh:3-4\n    sha256: ${HASH}\n    commit: 4d1e7c0`,
        "# Install\n\n<!-- cite: node-floor -->\nThe installer needs Node 22.\n",
      ),
      CONFIG,
    );
    expect(plan.problems).toEqual([]);
    expect(plan.citations.entries).toHaveLength(1);
    const c = plan.citations.entries[0]!;
    expect(c).toMatchObject({
      id: "node-floor",
      src: "scripts/install.sh:3-4",
      spec: { kind: "file", path: "scripts/install.sh", range: { start: 3, end: 4 } },
      sha256: HASH,
      commit: "4d1e7c0",
      quote: false,
      origin: "frontmatter",
      index: 0,
    });
    // The entry's own line, from the frontmatter line map.
    expect(c.line).toBe(5);
    expect(c.anchors).toEqual([
      { line: 12, claim: "The installer needs Node 22.", claimLine: 13 },
    ]);
  });

  it("resolves an inline citation into the same shape", () => {
    const plan = resolvePage(
      page(
        CHECKED,
        `# Install\n\n<!-- cite: src=scripts/install.sh:3-4 sha256=${HASH} commit=4d1e7c0 -->\nThe installer needs Node 22.\n`,
      ),
      CONFIG,
    );
    expect(plan.problems).toEqual([]);
    const c = plan.citations.entries[0]!;
    expect(c).toMatchObject({
      id: "inline-7",
      src: "scripts/install.sh:3-4",
      sha256: HASH,
      commit: "4d1e7c0",
      quote: false,
      origin: "inline",
      line: 7,
    });
    expect(c.comment?.syntax).toBe("html");
    expect(c.anchors).toEqual([{ line: 7, claim: "The installer needs Node 22.", claimLine: 8 }]);
  });

  it("lets an inline citation name itself, and reads a bare quote flag", () => {
    const plan = resolvePage(
      page(CHECKED, `<!-- cite: id=node-floor src=a.sh quote -->\nClaim.\n`),
      CONFIG,
    );
    expect(plan.citations.entries[0]).toMatchObject({ id: "node-floor", quote: true });
  });

  it("applies cite-commit as the default and lets an entry override it", () => {
    const plan = resolvePage(
      page(
        `${CHECKED}\ncite-commit: abcdef1\ncites:\n  - id: a\n    src: a.sh\n    sha256: ${HASH}\n  - id: b\n    src: b.sh\n    sha256: ${HASH}\n    commit: 1234abc`,
        "<!-- cite: src=c.sh -->\nClaim.\n",
      ),
      CONFIG,
    );
    expect(plan.citations.entries.map((c) => [c.id, c.commit])).toEqual([
      ["a", "abcdef1"],
      ["b", "1234abc"],
      ["inline-14", "abcdef1"],
    ]);
  });

  it("leaves an unminted citation without a hash rather than inventing one", () => {
    const plan = resolvePage(page(CHECKED, "<!-- cite: src=a.sh -->\nClaim.\n"), CONFIG);
    expect(plan.problems).toEqual([]);
    expect(plan.citations.entries[0]?.sha256).toBeUndefined();
  });

  it("orders frontmatter entries before inline ones, each in file order", () => {
    const plan = resolvePage(
      page(
        `${CHECKED}\ncites:\n  - id: z\n    src: z.sh\n  - id: a\n    src: a.sh`,
        "<!-- cite: src=m.sh -->\nM.\n\n<!-- cite: src=b.sh -->\nB.\n",
      ),
      CONFIG,
    );
    expect(plan.citations.entries.map((c) => c.src)).toEqual(["z.sh", "a.sh", "m.sh", "b.sh"]);
  });

  it("records every reference to one entry as an anchor", () => {
    const plan = resolvePage(
      page(
        `${CHECKED}\ncites:\n  - id: a\n    src: a.sh`,
        "<!-- cite: a -->\nFirst.\n\n<!-- cite: a -->\nSecond.\n",
      ),
      CONFIG,
    );
    expect(plan.citations.entries[0]?.anchors.map((a) => a.claim)).toEqual(["First.", "Second."]);
  });

  it("leaves an entry with no comment unanchored", () => {
    const plan = resolvePage(page(`${CHECKED}\ncites:\n  - id: a\n    src: a.sh`, "Body.\n"), CONFIG);
    expect(plan.citations.entries[0]?.anchors).toEqual([]);
  });

  it("collects a reference naming no entry as an orphan", () => {
    const plan = resolvePage(page(CHECKED, "<!-- cite: nope -->\nClaim.\n"), CONFIG);
    expect(plan.citations.orphans).toEqual([{ id: "nope", line: 5 }]);
  });

  it("errors on a duplicate frontmatter id", () => {
    const plan = resolvePage(
      page(`${CHECKED}\ncites:\n  - id: a\n    src: a.sh\n  - id: a\n    src: b.sh`, "Body.\n"),
      CONFIG,
    );
    expect(plan.problems).toEqual([
      expect.objectContaining({ level: "error", message: expect.stringContaining('citation id "a"') }),
    ]);
  });

  it("errors on an inline id that collides with a frontmatter id", () => {
    const plan = resolvePage(
      page(`${CHECKED}\ncites:\n  - id: a\n    src: a.sh`, "<!-- cite: id=a src=b.sh -->\nClaim.\n"),
      CONFIG,
    );
    expect(plan.problems[0]?.level).toBe("error");
    expect(plan.problems[0]?.line).toBe(8);
  });

  it("rejects a misspelled inline field through the shared schema definition", () => {
    const plan = resolvePage(page(CHECKED, "<!-- cite: src=a.sh claim=x -->\nClaim.\n"), CONFIG);
    expect(plan.problems).toEqual([
      expect.objectContaining({
        level: "error",
        line: 5,
        message: expect.stringContaining("claim"),
      }),
    ]);
    expect(plan.citations.entries).toEqual([]);
  });

  it("rejects an inline hash that is not 64 hex characters, like the frontmatter form", () => {
    const plan = resolvePage(page(CHECKED, "<!-- cite: src=a.sh sha256=abc -->\nClaim.\n"), CONFIG);
    expect(plan.problems[0]?.message).toContain("sha256");
  });

  it("errors on a comment that is neither a reference nor tokens", () => {
    const plan = resolvePage(page(CHECKED, "<!-- cite: two words -->\nClaim.\n"), CONFIG);
    expect(plan.problems[0]).toMatchObject({ level: "error", line: 5 });
  });

  it("errors on a src that does not parse", () => {
    const plan = resolvePage(
      page(`${CHECKED}\ncites:\n  - id: a\n    src: "a.sh:5-3"`, "Body.\n"),
      CONFIG,
    );
    expect(plan.problems[0]).toMatchObject({
      level: "error",
      message: expect.stringContaining("5-3"),
    });
  });

  it("explains an all-digit commit, which YAML reads as a number", () => {
    // 1 in 27 short shas is all digits. Unquoted, YAML hands the schema an
    // integer, and "must be string" alone sends the author to the wrong fix.
    const plan = resolvePage(page("cite-commit: 1234567", "Body.\n"), CONFIG);
    expect(plan.problems[0]?.message).toMatch(/quote/);
  });

  it("names the cite- reservation when a key under it is misspelled", () => {
    const plan = resolvePage(page("cite-comit: 4d1e7c0", "Body.\n"), CONFIG);
    expect(plan.problems[0]?.message).toMatch(/"cite-" prefix is reserved/);
    expect(plan.problems[0]?.message).toContain("cite-commit");
  });

  it("warns when a page declares citations that no eval checks", () => {
    const plan = resolvePage(page("cites:\n  - id: a\n    src: a.sh", "Body.\n"), CONFIG);
    expect(plan.problems).toEqual([
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("tool:citations"),
      }),
    ]);
    // Still resolved: the warning is about the config, not the page.
    expect(plan.citations.entries).toHaveLength(1);
  });

  it("does not warn when a tool:citations eval applies", () => {
    const plan = resolvePage(page(`${CHECKED}\ncites:\n  - id: a\n    src: a.sh`, "Body.\n"), CONFIG);
    expect(plan.problems).toEqual([]);
  });

  it("resolves a page with no citations to an empty list and no problems", () => {
    const plan = resolvePage(page("title: Plain", "Body.\n"), CONFIG);
    expect(plan.citations).toEqual({ entries: [], orphans: [] });
    expect(plan.problems).toEqual([]);
  });

  it("does not read a comment shown inside a code block as a citation", () => {
    const plan = resolvePage(
      page(CHECKED, "```markdown\n<!-- cite: src=a.sh -->\n```\n"),
      CONFIG,
    );
    expect(plan.citations.entries).toEqual([]);
  });
});
