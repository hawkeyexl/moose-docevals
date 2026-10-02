/**
 * Regressions from the self-review of the citations change (PR 29). Each
 * describe names the defect it pins; all of them were silent in the first
 * version: a path that only resolves on Windows, a page dropped for a
 * duplicate id nobody wrote, a search that never returns, a false accusation
 * of a hand-typed hash, a range quietly widened to the whole file.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractFrontmatter } from "docmeta";
import { parseDocevalsConfig } from "../helpers/config.js";
import { stripFrontmatterBlock, type PageFile } from "../../src/core/discover.js";
import { resolvePage } from "../../src/core/resolve.js";
import { runEvals } from "../../src/core/engine.js";
import { updatePageCite } from "../../src/core/frontmatter-edit.js";
import { classifyCitation, type ClassifyReaders } from "../../src/citations/classify.js";
import { fencedBlockAfter, scanCiteComments } from "../../src/citations/comments.js";
import { hashRange, parseSrc } from "../../src/citations/hash.js";
import { updateInlineTokens } from "../../src/citations/inline-edit.js";
import type { Citation } from "../../src/citations/types.js";
import { portableSrc, runCiteAdd, runCiteRefresh } from "../../src/commands/cite.js";
import type { ExecFn, ExecResult } from "../../src/graders/types.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = ["#!/bin/sh", "set -e", "need node 22", "or later", "echo done"].join("\n") + "\n";
const HASH = hashRange(SOURCE, { start: 3, end: 4 })!;
const HEAD = "4d1e7c0f4d1e7c0f4d1e7c0f4d1e7c0f4d1e7c0f";
const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false };

const CONFIG_LINES = [
  "docevals:",
  "  version: 1",
  "  files:",
  '    include: ["docs/**/*.{md,mdx}"]',
  "  defaults:",
  "    suite: default",
  "  evals:",
  "    cited-sources-current:",
  "      assertion: Cited sources are current.",
  "      grader: tool:citations",
  "      severity: warning",
  "  suites:",
  "    default:",
  "      evals: [cited-sources-current]",
  "",
];

function scaffold(pages: Record<string, string[]>, source: string = SOURCE): string {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, ".tmp", "citations-review-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [name, lines] of Object.entries(pages)) {
    writeFileSync(join(root, "docs", name), lines.join("\n"));
  }
  writeFileSync(join(root, "src", "install.sh"), source);
  writeFileSync(join(root, "moose.config.yaml"), CONFIG_LINES.join("\n"));
  return root;
}

function fakeRepo(committed: string): ExecFn {
  return (cmd) => {
    if (cmd[1] === "rev-parse") return Promise.resolve({ ...OK, stdout: `${HEAD}\n` });
    if (cmd[2] === "show") return Promise.resolve({ ...OK, stdout: committed });
    return Promise.resolve(OK);
  };
}

const noGit: ExecFn = () => Promise.resolve({ ...OK, spawnError: "ENOENT" });
const read = (root: string, name: string) => readFileSync(join(root, "docs", name), "utf8");

describe("a Windows path is recorded with forward slashes", () => {
  it("normalizes backslashes when the platform separator is a backslash", () => {
    expect(portableSrc("scripts\\install.sh:3-4", "\\")).toBe("scripts/install.sh:3-4");
    expect(portableSrc("C:\\repo\\spec.md:2", "\\")).toBe("C:/repo/spec.md:2");
  });

  it("leaves a POSIX path alone, where a backslash is a legal filename character", () => {
    expect(portableSrc("odd\\name.sh:1", "/")).toBe("odd\\name.sh:1");
  });

  it("never touches a URL", () => {
    expect(portableSrc("https://example.com/a\\b.txt", "\\")).toBe("https://example.com/a\\b.txt");
  });
});

describe("two inline citations on one line", () => {
  const CONFIG = parseDocevalsConfig(`version: 1
evals:
  cited-sources-current:
    assertion: Cited sources are current.
    grader: tool:citations
`);

  function page(body: string): PageFile {
    const content = `---\nevals:\n  - use: cited-sources-current\n---\n${body}`;
    return {
      file: "docs/page.md",
      absPath: "/fake/docs/page.md",
      content,
      body: stripFrontmatterBlock(content),
      frontmatter: extractFrontmatter(content, "markdown"),
    };
  }

  it("each get their own id, and the page resolves without a problem", () => {
    const plan = resolvePage(
      page("First. <!-- cite: src=a.sh:1 --> Second. <!-- cite: src=b.sh:2 -->\n"),
      CONFIG,
    );
    expect(plan.problems).toEqual([]);
    expect(plan.citations.entries.map((c) => [c.id, c.src])).toEqual([
      ["inline-5", "a.sh:1"],
      ["inline-5-2", "b.sh:2"],
    ]);
  });

  it("does not hand out an id an author already used", () => {
    const plan = resolvePage(
      page("<!-- cite: id=inline-7 src=x.sh -->\nX.\n<!-- cite: src=y.sh -->\nY.\n"),
      CONFIG,
    );
    // The unnamed comment is on line 7, and an author already took
    // `inline-7`. The derived id steps past it instead of colliding.
    expect(plan.problems).toEqual([]);
    expect(plan.citations.entries.map((c) => c.id)).toEqual(["inline-7", "inline-7-2"]);
  });

  it("keeps another citation's comment out of the claim", () => {
    const [first] = scanCiteComments("First. <!-- cite: src=a.sh:1 --> Second. <!-- cite: src=b.sh:2 -->\n");
    expect(first?.claim).not.toContain("cite:");
  });
});

describe("the moved search is bounded by work, not only by file size", () => {
  function cite(src: string, extra: Partial<Citation> = {}): Citation {
    const parsed = parseSrc(src);
    if (!parsed.ok) throw new Error(parsed.error);
    return { id: "c", src, spec: parsed.spec, sha256: "0".repeat(64), quote: false, origin: "inline", line: 1, anchors: [], ...extra };
  }
  // 30,000 lines of 50 characters: 1.5 MB, under the size cap. A 15,000-line
  // range is 15,001 windows of 750 KB each, about 11 GB to hash.
  const big = Array.from({ length: 30_000 }, (_, i) => String(i).padStart(49, "x")).join("\n") + "\n";
  const readers = (history?: string): ClassifyReaders => ({
    readSource: () => Promise.resolve({ ok: true, text: big }),
    ...(history !== undefined
      ? { readAtCommit: () => Promise.resolve({ ok: true, text: history }) }
      : {}),
  });

  it("skips a search that would hash gigabytes, and says so", async () => {
    const started = Date.now();
    const r = await classifyCitation(cite("big.txt:1-15000"), readers());
    expect(r.status).toBe("changed");
    expect(r.detail).toMatch(/too large/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not accuse a citation of never being true when it could not look", async () => {
    const r = await classifyCitation(cite("big.txt:1-15000", { commit: "4d1e7c0" }), readers(big));
    expect(r.neverTrue).toBeUndefined();
  });
});

describe("re-minting without a commit drops the stale one", () => {
  const STALE = "aaaaaaa";

  it("inline: the commit token is removed, nothing else moves", async () => {
    const edited = SOURCE.replace("need node 22", "need node 24");
    const root = scaffold(
      { "page.md": ["---", "title: T", "---", `<!-- cite: id=x src=src/install.sh:3-4 sha256=${HASH} commit=${STALE} quote=false -->`, "Claim.", ""] },
      edited,
    );
    await runCiteRefresh([], { cwd: root, exec: noGit, acceptChanged: true, noCommit: true });
    expect(read(root, "page.md")).toContain(
      `<!-- cite: id=x src=src/install.sh:3-4 sha256=${hashRange(edited, { start: 3, end: 4 })!} quote=false -->`,
    );
  });

  it("frontmatter: the commit field is removed", async () => {
    const edited = SOURCE.replace("need node 22", "need node 24");
    const root = scaffold(
      {
        "page.md": ["---", "title: T", "cites:", "  - id: a", "    src: src/install.sh:3-4", `    sha256: ${HASH}`, `    commit: ${STALE}`, "---", "Body.", ""],
      },
      edited,
    );
    await runCiteRefresh([], { cwd: root, exec: noGit, acceptChanged: true, noCommit: true });
    expect(read(root, "page.md")).not.toContain("commit:");
    expect(read(root, "page.md")).toContain(`sha256: ${hashRange(edited, { start: 3, end: 4 })!}`);
  });

  it("updateInlineTokens removes a token given null, with its separator", () => {
    expect(updateInlineTokens("src=a.sh sha256=abc commit=aaaaaaa quote", { commit: null })).toBe(
      "src=a.sh sha256=abc quote",
    );
    expect(updateInlineTokens("commit=aaaaaaa src=a.sh", { commit: null })).toBe("src=a.sh");
    expect(updateInlineTokens("src=a.sh", { commit: null })).toBe("src=a.sh");
  });

  it("updatePageCite removes a field given null", () => {
    const page = ["---", "cites:", "  - id: a", "    src: a.sh", "    commit: aaaaaaa", "---", "Body.", ""].join("\n");
    const out = updatePageCite(page, "docs/page.md", "a", { commit: null });
    expect(out).not.toContain("commit:");
    expect(out.endsWith("---\nBody.\n")).toBe(true);
  });
});

// The stale-commit fix above removes an entry's own commit. It could not help
// a citation that *inherits* its commit from the page's `cite-commit`: there
// is nothing at the entry to remove, so a hash minted with no commit quietly
// re-inherited one it was never checked against. `commit: none` is the entry
// saying so, and every commit-less mint writes it when a page default applies.
describe("a commit-less mint on a page with cite-commit", () => {
  const PAGE_COMMIT = "bbbbbbb";
  const edited = SOURCE.replace("need node 22", "need node 24");
  const EDITED_HASH = hashRange(edited, { start: 3, end: 4 })!;

  const CONFIG = parseDocevalsConfig(`version: 1
evals:
  cited-sources-current:
    assertion: Cited sources are current.
    grader: tool:citations
`);
  function pageOf(frontmatter: string, body: string): PageFile {
    const content = `---\nevals:\n  - use: cited-sources-current\n${frontmatter}\n---\n${body}`;
    return {
      file: "docs/page.md",
      absPath: "/fake/docs/page.md",
      content,
      body: stripFrontmatterBlock(content),
      frontmatter: extractFrontmatter(content, "markdown"),
    };
  }

  it("resolves commit: none as no commit, without inheriting the page default", () => {
    const plan = resolvePage(
      pageOf(
        `cite-commit: ${PAGE_COMMIT}\ncites:\n  - id: a\n    src: a.sh\n    commit: none\n  - id: b\n    src: b.sh`,
        "<!-- cite: src=c.sh commit=none -->\nC.\n<!-- cite: src=d.sh -->\nD.\n",
      ),
      CONFIG,
    );
    expect(plan.problems).toEqual([]);
    expect(plan.citations.entries.map((c) => [c.src, c.commit])).toEqual([
      ["a.sh", undefined],
      ["b.sh", PAGE_COMMIT],
      ["c.sh", undefined],
      ["d.sh", PAGE_COMMIT],
    ]);
  });

  it("does not accept none as the page default itself", () => {
    const plan = resolvePage(pageOf("cite-commit: none", "Body.\n"), CONFIG);
    expect(plan.problems[0]?.level).toBe("error");
  });

  it("re-mint: an inline citation that inherited the page commit gains commit=none", async () => {
    const root = scaffold(
      { "page.md": ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "---", `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Claim.", ""] },
      edited,
    );
    await runCiteRefresh([], { cwd: root, exec: noGit, acceptChanged: true, noCommit: true });
    expect(read(root, "page.md")).toContain(
      `<!-- cite: src=src/install.sh:3-4 sha256=${EDITED_HASH} commit=none -->`,
    );
  });

  it("re-mint: a frontmatter entry that inherited the page commit gains commit: none", async () => {
    const root = scaffold(
      { "page.md": ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "cites:", "  - id: a", "    src: src/install.sh:3-4", `    sha256: ${HASH}`, "---", "Body.", ""] },
      edited,
    );
    await runCiteRefresh([], { cwd: root, exec: noGit, acceptChanged: true, noCommit: true });
    const page = read(root, "page.md");
    expect(page).toContain("    commit: none\n");
    expect(page).toContain(`cite-commit: ${PAGE_COMMIT}\n`);
  });

  it("re-mint: an entry's own commit becomes none rather than falling back to the page's", async () => {
    const root = scaffold(
      { "page.md": ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "---", `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} commit=aaaaaaa -->`, "Claim.", ""] },
      edited,
    );
    await runCiteRefresh([], { cwd: root, exec: noGit, acceptChanged: true, noCommit: true });
    expect(read(root, "page.md")).toContain(`sha256=${EDITED_HASH} commit=none -->`);
  });

  it("mint: an unminted citation minted with --no-commit does not inherit the page commit", async () => {
    const root = scaffold({
      "page.md": ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "---", "<!-- cite: src=src/install.sh:3-4 -->", "Claim.", ""],
    });
    await runCiteRefresh([], { cwd: root, exec: noGit, noCommit: true });
    expect(read(root, "page.md")).toContain(`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} commit=none -->`);
  });

  it("a later mint with a commit replaces none", async () => {
    const root = scaffold(
      { "page.md": ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "---", `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} commit=none -->`, "Claim.", ""] },
      edited,
    );
    await runCiteRefresh([], { cwd: root, exec: fakeRepo(edited), acceptChanged: true });
    expect(read(root, "page.md")).toContain(`sha256=${EDITED_HASH} commit=${HEAD} -->`);
  });

  it("cite add --no-commit writes commit: none, in both forms", async () => {
    const page = ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "---", "Body.", ""];
    const root = scaffold({ "page.md": page });
    const added = await runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true });
    expect(added.entry.commit).toBe("none");
    expect(read(root, "page.md")).toContain("    commit: none\n");

    const inline = await runCiteAdd("docs/page.md", "src/install.sh:5", { cwd: root, exec: noGit, noCommit: true, inline: true });
    expect(inline.inlineComment).toMatch(/ commit=none -->$/);
  });

  it("cite add --no-commit on a page with no cite-commit records no commit at all", async () => {
    const root = scaffold({ "page.md": ["---", "title: T", "---", "Body.", ""] });
    const added = await runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true });
    expect(added.entry.commit).toBeUndefined();
    expect(read(root, "page.md")).not.toContain("commit");
  });

  it("the grader reports changed, never never-true, and does not consult git", async () => {
    const root = scaffold(
      { "page.md": ["---", "title: T", `cite-commit: ${PAGE_COMMIT}`, "---", `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} commit=none -->`, "Claim.", ""] },
      edited,
    );
    const calls: string[][] = [];
    const spy: ExecFn = (cmd) => {
      calls.push(cmd);
      // A history in which the bytes never existed: exactly what would turn
      // an inherited commit into a false never-true.
      return Promise.resolve({ ...OK, stdout: "nothing like it\n" });
    };
    const report = await runEvals({ cwd: root, generate: false, exec: spy });
    expect(report.evalResults[0]?.findings?.map((f) => f.ruleId)).toEqual(["citations/changed"]);
    expect(calls).toEqual([]);
  });
});

describe("a line fragment on a URL that is not a GitHub file URL", () => {
  it("is an error, not a silent whole-file citation", () => {
    const r = parseSrc("https://gitlab.com/o/r/-/raw/main/x.ts#L5-L9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/:5-9/);
  });

  it("rejects any other fragment too, since it is not part of the fetched file", () => {
    expect(parseSrc("https://example.com/spec.txt#section").ok).toBe(false);
  });
});

describe("an edit that throws does not abort cite refresh", () => {
  it("records the page, processes the rest, and exits 2", async () => {
    const root = scaffold({
      // TOML frontmatter resolves, but cannot be edited in place.
      "a-toml.md": ["+++", 'title = "T"', "[[cites]]", 'id = "a"', 'src = "src/install.sh:3-4"', "+++", "Body.", ""],
      "b-yaml.md": ["---", "title: U", "---", "<!-- cite: src=src/install.sh:5 -->", "B.", ""],
    });
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE) });
    expect(report.problems).toEqual([
      { file: "docs/a-toml.md", message: expect.stringMatching(/could not edit/) },
    ]);
    expect(report.filesWritten).toEqual(["docs/b-yaml.md"]);
    expect(report.exitCode).toBe(2);
    expect(report.entries.find((e) => e.file === "docs/a-toml.md")?.action).toBe("kept");
  });
});

describe("the quote check", () => {
  const run = async (root: string) => {
    const report = await runEvals({ cwd: root, generate: false, exec: noGit });
    const result = report.evalResults[0];
    return (result?.findings ?? []).map((f) => f.ruleId);
  };

  it("strips the fence's own indentation, as Markdown does, before comparing", async () => {
    const root = scaffold({
      "page.md": [
        "---",
        "title: T",
        "---",
        "1. Check the floor:",
        "",
        `    <!-- cite: src=src/install.sh:3-4 sha256=${HASH} quote -->`,
        "    ```sh",
        "    need node 22",
        "    or later",
        "    ```",
        "",
      ],
    });
    expect(await run(root)).toEqual([]);
  });

  it("reports a quote citation no comment names, rather than checking an unrelated block", async () => {
    const root = scaffold({
      "page.md": [
        "---",
        "title: T",
        "cites:",
        "  - id: a",
        "    src: src/install.sh:3-4",
        `    sha256: ${HASH}`,
        "    quote: true",
        "---",
        "An unrelated example:",
        "",
        "```sh",
        "npm test",
        "```",
        "",
      ],
    });
    expect(await run(root)).toEqual(["citations/quote-missing"]);
  });

  it("fencedBlockAfter dedents by the opening fence's indentation only", () => {
    const lines = ["x", "  ```", "    deeper", "  flush", "  ```"];
    expect(fencedBlockAfter(lines, 0, lines.length)).toEqual({ text: "  deeper\nflush", line: 2 });
  });
});

describe("cite add --inline", () => {
  const PAGE = ["---", "title: T", "cites:", "  - id: install-3-4", "    src: other.sh", "---", "Body.", ""];

  it("carries an id the author asked for", async () => {
    const root = scaffold({ "page.md": ["---", "title: T", "---", "Body.", ""] });
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", {
      cwd: root,
      exec: noGit,
      noCommit: true,
      inline: true,
      id: "node-floor",
    });
    expect(r.inlineComment).toBe(`<!-- cite: id=node-floor src=src/install.sh:3-4 sha256=${HASH} -->`);
  });

  it("does not check a derived id the comment will never carry", async () => {
    const root = scaffold({ "page.md": PAGE });
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true, inline: true });
    expect(r.inlineComment).toBe(`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`);
  });

  it("still refuses an explicit id that collides", async () => {
    const root = scaffold({ "page.md": PAGE });
    await expect(
      runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true, inline: true, id: "install-3-4" }),
    ).rejects.toThrow(/--id/);
  });
});

describe("a fence carrying an info string does not close a code block", () => {
  const content = [
    "Show the syntax:",
    "",
    "```markdown",
    "```bash",
    "<!-- cite: src=example.sh:1 -->",
    "```",
    "",
    "<!-- cite: real -->",
    "A real one.",
    "",
  ].join("\n");

  it("keeps the example inside the block and finds the real comment after it", () => {
    const found = scanCiteComments(content);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "reference", id: "real", line: 8 });
  });

  it("fencedBlockAfter reads through an inner fence line with an info string", () => {
    const lines = ["```markdown", "```bash", "npm i", "```", "after"];
    expect(fencedBlockAfter(lines, 0, lines.length)).toEqual({ text: "```bash\nnpm i", line: 1 });
  });
});
