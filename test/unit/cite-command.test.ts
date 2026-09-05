/**
 * `moose-docevals cite add` and `cite refresh` (ADR 01046).
 *
 * `add` mints one citation and writes it to frontmatter, or prints it as an
 * inline comment. `refresh` mints every unminted citation in place, rewrites
 * a moved range, and re-mints a changed one only under `--accept-changed`.
 * Both forms, both directions. Git is a fake `ExecFn` modelling a one-file
 * repository; corpora live under `.tmp/`.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCiteAdd, runCiteRefresh, renderCiteAdd, renderCiteRefresh } from "../../src/commands/cite.js";
import { hashRange } from "../../src/citations/hash.js";
import { scanCiteComments } from "../../src/citations/comments.js";
import { DocevalsError } from "../../src/types.js";
import type { ExecFn, ExecResult } from "../../src/graders/types.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = ["#!/bin/sh", "set -e", "need node 22", "or later", "echo done"].join("\n") + "\n";
const HASH = hashRange(SOURCE, { start: 3, end: 4 })!;
const HEAD = "4d1e7c0f4d1e7c0f4d1e7c0f4d1e7c0f4d1e7c0f";

function scaffold(page: string[], source: string | null = SOURCE, ext = "md"): string {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, ".tmp", "cite-command-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "docs", `page.${ext}`), page.join("\n"));
  if (source !== null) writeFileSync(join(root, "src", "install.sh"), source);
  writeFileSync(
    join(root, "moose.config.yaml"),
    [
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
    ].join("\n"),
  );
  return root;
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false };

/** A repository whose HEAD holds `committed` at src/install.sh. */
function fakeRepo(committed: string | undefined, subjects: string[] = []): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "rev-parse") return Promise.resolve({ ...OK, stdout: `${HEAD}\n` });
    if (cmd[2] === "show") {
      return Promise.resolve(
        committed === undefined
          ? { ...OK, code: 128, stderr: "fatal: path 'src/install.sh' does not exist" }
          : { ...OK, stdout: committed },
      );
    }
    if (cmd[2] === "log") return Promise.resolve({ ...OK, stdout: subjects.map((s) => `${s}\0`).join("") });
    return Promise.resolve(OK);
  };
  return { exec, calls };
}

const noGit: ExecFn = () => Promise.resolve({ ...OK, spawnError: "ENOENT" });

const PAGE = ["---", "title: Install", "---", "", "# Install", "", "Needs Node 22.", ""];

describe("cite add", () => {
  it("mints and appends a frontmatter entry, and prints the reference comment to paste", async () => {
    const root = scaffold(PAGE);
    const { exec } = fakeRepo(SOURCE);
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec });
    expect(r.entry).toEqual({ id: "install-3-4", src: "src/install.sh:3-4", sha256: HASH, commit: HEAD });
    expect(r.written).toBe(true);
    expect(r.referenceHint).toBe("<!-- cite: install-3-4 -->");
    const page = readFileSync(join(root, "docs", "page.md"), "utf8");
    expect(page).toContain("cites:");
    expect(page).toContain(`sha256: ${HASH}`);
    expect(page.endsWith("# Install\n\nNeeds Node 22.\n")).toBe(true);
  });

  it("takes --id and --quote", async () => {
    const root = scaffold(PAGE);
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", {
      cwd: root,
      exec: fakeRepo(SOURCE).exec,
      id: "node-floor",
      quote: true,
    });
    expect(r.entry).toMatchObject({ id: "node-floor", quote: true });
  });

  it("does not print the hint when the body already references the id", async () => {
    const root = scaffold(["---", "title: T", "---", "<!-- cite: node-floor -->", "Claim.", ""]);
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", {
      cwd: root,
      exec: fakeRepo(SOURCE).exec,
      id: "node-floor",
    });
    expect(r.referenceHint).toBeUndefined();
  });

  it("--inline prints a minted comment in the page's syntax and writes nothing", async () => {
    const root = scaffold(PAGE, SOURCE, "mdx");
    const before = readFileSync(join(root, "docs", "page.mdx"), "utf8");
    const r = await runCiteAdd("docs/page.mdx", "src/install.sh:3-4", {
      cwd: root,
      exec: fakeRepo(SOURCE).exec,
      inline: true,
    });
    expect(r.written).toBe(false);
    expect(r.inlineComment).toBe(`{/* cite: src=src/install.sh:3-4 sha256=${HASH} commit=${HEAD} */}`);
    expect(readFileSync(join(root, "docs", "page.mdx"), "utf8")).toBe(before);
    // What it prints scans back as the same citation.
    const [scanned] = scanCiteComments(`${r.inlineComment ?? ""}\nClaim.\n`);
    expect(scanned).toMatchObject({ kind: "inline", entry: { src: "src/install.sh:3-4", sha256: HASH } });
  });

  it("--dry-run reports the entry and writes nothing", async () => {
    const root = scaffold(PAGE);
    const before = readFileSync(join(root, "docs", "page.md"), "utf8");
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", {
      cwd: root,
      exec: fakeRepo(SOURCE).exec,
      dryRun: true,
    });
    expect(r.written).toBe(false);
    expect(r.entry.sha256).toBe(HASH);
    expect(readFileSync(join(root, "docs", "page.md"), "utf8")).toBe(before);
  });

  it("refuses to record a commit when the source has uncommitted changes", async () => {
    const root = scaffold(PAGE);
    const committed = SOURCE.replace("need node 22", "need node 20");
    await expect(
      runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: fakeRepo(committed).exec }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it("refuses an untracked source, naming --no-commit as the way out", async () => {
    const root = scaffold(PAGE);
    await expect(
      runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: fakeRepo(undefined).exec }),
    ).rejects.toThrow(/--no-commit/);
  });

  it("--no-commit mints without git at all", async () => {
    const root = scaffold(PAGE);
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true });
    expect(r.entry).toEqual({ id: "install-3-4", src: "src/install.sh:3-4", sha256: HASH });
  });

  it("names git as the missing piece when it is not on PATH", async () => {
    const root = scaffold(PAGE);
    await expect(
      runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit }),
    ).rejects.toThrow(/git/);
  });

  it("mints a URL source through fetch, taking a sha ref as the commit", async () => {
    const root = scaffold(PAGE);
    const fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SOURCE) });
    const r = await runCiteAdd("docs/page.md", `https://github.com/o/r/blob/${HEAD}/src/install.sh#L3-L4`, {
      cwd: root,
      exec: noGit,
      fetch,
    });
    expect(r.entry).toMatchObject({ id: "install-3-4", sha256: HASH, commit: HEAD });
  });

  it("is a usage error when the source is missing or the range is past the end", async () => {
    const root = scaffold(PAGE, null);
    await expect(runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true })).rejects.toThrow(
      DocevalsError,
    );
    const root2 = scaffold(PAGE);
    await expect(runCiteAdd("docs/page.md", "src/install.sh:30-40", { cwd: root2, exec: noGit, noCommit: true })).rejects.toThrow(
      /5 lines/,
    );
  });

  it("is a usage error when the id already exists on the page, naming --id", async () => {
    const root = scaffold(["---", "title: T", "cites:", "  - id: install-3-4", "    src: x.sh", "---", "Body.", ""]);
    await expect(
      runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: noGit, noCommit: true }),
    ).rejects.toThrow(/--id/);
  });

  it("renders the result as human text and as json", async () => {
    const root = scaffold(PAGE);
    const r = await runCiteAdd("docs/page.md", "src/install.sh:3-4", { cwd: root, exec: fakeRepo(SOURCE).exec });
    expect(renderCiteAdd(r, "human")).toContain("<!-- cite: install-3-4 -->");
    expect(JSON.parse(renderCiteAdd(r, "json"))).toMatchObject({ entry: { sha256: HASH } });
  });
});

describe("cite refresh", () => {
  const read = (root: string, name = "page.md") => readFileSync(join(root, "docs", name), "utf8");

  it("mints an unminted inline citation in place, leaving the rest of the file byte-identical", async () => {
    const root = scaffold(["---", "title: T", "---", "", "<!-- cite: src=src/install.sh:3-4 -->", "Needs Node 22.", ""]);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec });
    expect(report.entries).toEqual([
      expect.objectContaining({ id: "inline-5", status: "unminted", action: "minted" }),
    ]);
    expect(read(root)).toBe(
      `---\ntitle: T\n---\n\n<!-- cite: src=src/install.sh:3-4 sha256=${HASH} commit=${HEAD} -->\nNeeds Node 22.\n`,
    );
  });

  it("mints an unminted frontmatter entry", async () => {
    const root = scaffold(["---", "title: T", "cites:", "  - id: a", "    src: src/install.sh:3-4", "---", "Body.", ""]);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec });
    expect(report.entries[0]).toMatchObject({ id: "a", action: "minted" });
    expect(read(root)).toContain(`    sha256: ${HASH}\n    commit: ${HEAD}\n`);
    expect(read(root).endsWith("---\nBody.\n")).toBe(true);
  });

  it("rewrites a moved range in both forms", async () => {
    const root = scaffold(
      [
        "---",
        "title: T",
        "cites:",
        "  - id: a",
        "    src: src/install.sh:3-4",
        `    sha256: ${HASH}`,
        "---",
        "",
        "<!-- cite: a -->",
        "A.",
        `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`,
        "B.",
        "",
      ],
      "# license\n# header\n" + SOURCE,
    );
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec });
    expect(report.entries.map((e) => [e.id, e.status, e.action, e.newSrc])).toEqual([
      ["a", "moved", "rewritten", "src/install.sh:5-6"],
      ["inline-11", "moved", "rewritten", "src/install.sh:5-6"],
    ]);
    const page = read(root);
    expect(page).toContain("    src: src/install.sh:5-6\n");
    expect(page).toContain(`<!-- cite: src=src/install.sh:5-6 sha256=${HASH} -->\nB.\n`);
    expect(page).toContain("<!-- cite: a -->\nA.\n");
  });

  it("keeps a changed citation unless --accept-changed, then re-mints it", async () => {
    const page = ["---", "title: T", "---", `<!-- cite: src=src/install.sh:3-4 sha256=${"0".repeat(64)} -->`, "Claim.", ""];
    const edited = SOURCE.replace("need node 22", "need node 24");

    const kept = scaffold(page, edited);
    const r1 = await runCiteRefresh([], { cwd: kept, exec: fakeRepo(edited).exec });
    expect(r1.entries[0]).toMatchObject({ status: "changed", action: "kept" });
    expect(read(kept)).toContain(`sha256=${"0".repeat(64)}`);

    const accepted = scaffold(page, edited);
    const r2 = await runCiteRefresh([], { cwd: accepted, exec: fakeRepo(edited).exec, acceptChanged: true });
    expect(r2.entries[0]).toMatchObject({ status: "changed", action: "re-minted" });
    expect(read(accepted)).toContain(`sha256=${hashRange(edited, { start: 3, end: 4 })!} commit=${HEAD}`);
  });

  it("reports a never-true citation and re-mints it only under --accept-changed", async () => {
    const page = ["---", "title: T", "---", `<!-- cite: src=src/install.sh:3-4 sha256=${"0".repeat(64)} commit=${HEAD} -->`, "Claim.", ""];
    const kept = scaffold(page);
    const r1 = await runCiteRefresh([], { cwd: kept, exec: fakeRepo(SOURCE).exec });
    expect(r1.entries[0]).toMatchObject({ status: "never-true", action: "kept" });

    const accepted = scaffold(page);
    const r2 = await runCiteRefresh([], { cwd: accepted, exec: fakeRepo(SOURCE).exec, acceptChanged: true });
    expect(r2.entries[0]).toMatchObject({ status: "never-true", action: "re-minted" });
    expect(read(accepted)).toContain(`sha256=${HASH}`);
  });

  it("leaves a current citation alone and says so", async () => {
    const root = scaffold(["---", "title: T", "---", `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Claim.", ""]);
    const before = read(root);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec });
    expect(report.entries[0]).toMatchObject({ status: "current", action: "unchanged" });
    expect(report.filesWritten).toEqual([]);
    expect(read(root)).toBe(before);
  });

  it("reports a missing source and never rewrites it", async () => {
    const root = scaffold(["---", "title: T", "---", `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Claim.", ""], null);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec, acceptChanged: true });
    expect(report.entries[0]).toMatchObject({ status: "missing", action: "kept" });
  });

  it("reports a mint it had to refuse, per entry, and carries on", async () => {
    const root = scaffold(["---", "title: T", "---", "<!-- cite: src=src/install.sh:3-4 -->", "Claim.", ""]);
    const committed = SOURCE.replace("need node 22", "need node 20");
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(committed).exec });
    expect(report.entries[0]).toMatchObject({ status: "unminted", action: "kept" });
    expect(report.entries[0]?.detail).toMatch(/uncommitted/);
    expect(read(root)).toContain("<!-- cite: src=src/install.sh:3-4 -->");
  });

  it("--no-commit mints without recording a commit", async () => {
    const root = scaffold(["---", "title: T", "---", "<!-- cite: src=src/install.sh:3-4 -->", "Claim.", ""]);
    await runCiteRefresh([], { cwd: root, exec: noGit, noCommit: true });
    expect(read(root)).toContain(`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`);
  });

  it("--dry-run reports every action and writes nothing", async () => {
    const root = scaffold(["---", "title: T", "---", "<!-- cite: src=src/install.sh:3-4 -->", "Claim.", ""]);
    const before = read(root);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec, dryRun: true });
    expect(report.entries[0]).toMatchObject({ action: "minted" });
    expect(report.filesWritten).toEqual([]);
    expect(read(root)).toBe(before);
  });

  it("skips a page with an error-level problem and reports it", async () => {
    const root = scaffold(["---", "title: T", "---", "<!-- cite: two words -->", "Claim.", ""]);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec });
    expect(report.entries).toEqual([]);
    expect(report.problems[0]?.message).toContain("two words");
  });

  it("renders one line per citation", async () => {
    const root = scaffold(["---", "title: T", "---", "<!-- cite: src=src/install.sh:3-4 -->", "Claim.", ""]);
    const report = await runCiteRefresh([], { cwd: root, exec: fakeRepo(SOURCE).exec });
    const text = renderCiteRefresh(report, "human");
    expect(text).toContain("minted");
    expect(text).toContain("src/install.sh:3-4");
    expect(JSON.parse(renderCiteRefresh(report, "json"))).toMatchObject({ entries: [{ action: "minted" }] });
  });
});
