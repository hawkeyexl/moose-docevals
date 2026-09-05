/**
 * `tool:citations`, driven through the real engine over a scaffolded corpus
 * (ADR 01045). Every status the classifier can return gets a case, in both
 * forms, at the severity that shows the rule: `warning`, where a page finding
 * reports and passes and a diagnostic one still fails (ADR 01022).
 *
 * Git is a fake `ExecFn`, fetch is a fake; nothing here leaves the machine.
 * Scratch corpora live under `.tmp/` in the worktree, per CLAUDE.md.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runEvals } from "../../src/core/engine.js";
import { hashRange } from "../../src/citations/hash.js";
import type { FetchLike } from "../../src/citations/source.js";
import type { ExecFn, ExecResult } from "../../src/graders/types.js";

const ROOT = resolve(import.meta.dirname, "../..");

const SOURCE = ["#!/bin/sh", "set -e", "need node 22", "or later", "echo done"].join("\n") + "\n";
const HASH = hashRange(SOURCE, { start: 3, end: 4 })!;
const COMMIT = "4d1e7c0";

interface Corpus {
  frontmatter?: string[];
  body: string[];
  /** Source file contents, at `src/install.sh`; absent means missing. */
  source?: string;
  severity?: "error" | "warning" | "info";
  options?: string[];
}

function scaffold(c: Corpus): string {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, ".tmp", "citations-grader-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "docs", "page.md"),
    [
      "---",
      "title: Install",
      "evals:",
      "  - use: subject",
      ...(c.frontmatter ?? []),
      "---",
      "",
      "# Install",
      "",
      ...c.body,
      "",
    ].join("\n"),
  );
  if (c.source !== undefined) writeFileSync(join(root, "src", "install.sh"), c.source);
  writeFileSync(
    join(root, "moose.config.yaml"),
    [
      "docevals:",
      "  version: 1",
      "  files:",
      '    include: ["docs/**/*.md"]',
      "  evals:",
      "    subject:",
      "      assertion: Cited sources are current.",
      "      grader: tool:citations",
      `      severity: ${c.severity ?? "warning"}`,
      ...(c.options ? ["      options:", ...c.options.map((o) => `        ${o}`)] : []),
      "",
    ].join("\n"),
  );
  return root;
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false };

/** A git whose `show` returns `then` for any commit, and whose log lists `subjects`. */
function fakeGit(then: string | undefined, subjects: string[] = []): ExecFn {
  return (cmd) => {
    if (cmd[2] === "show") {
      return Promise.resolve(
        then === undefined ? { ...OK, code: 128, stderr: "fatal: bad object" } : { ...OK, stdout: then },
      );
    }
    if (cmd[2] === "log") {
      return Promise.resolve({ ...OK, stdout: subjects.map((s) => `${s}\0`).join("") });
    }
    return Promise.resolve(OK);
  };
}

const noGit: ExecFn = () => Promise.resolve({ ...OK, spawnError: "ENOENT" });

async function run(root: string, exec: ExecFn = fakeGit(SOURCE), fetch?: FetchLike) {
  const report = await runEvals({ cwd: root, generate: false, exec, fetch });
  const errors = report.problems.filter((p) => p.level === "error");
  const result = report.evalResults[0];
  return { report, errors, result, findings: result?.findings ?? [] };
}

const ruleIds = (findings: { ruleId?: string }[]) => findings.map((f) => f.ruleId);

describe("tool:citations", () => {
  it("passes silently on a page with no citations", async () => {
    const { result, errors } = await run(scaffold({ body: ["Nothing cited."] }));
    expect(errors).toEqual([]);
    expect(result?.outcome).toBe("pass");
    expect(result?.findings).toBeUndefined();
  });

  it("passes a current inline citation with no findings", async () => {
    const { result } = await run(
      scaffold({
        body: [`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Needs Node 22."],
        source: SOURCE,
      }),
    );
    expect(result?.outcome).toBe("pass");
    expect(result?.findings).toBeUndefined();
  });

  it("passes a current frontmatter citation with a reference comment", async () => {
    const { result } = await run(
      scaffold({
        frontmatter: ["cites:", "  - id: node-floor", "    src: src/install.sh:3-4", `    sha256: ${HASH}`],
        body: ["<!-- cite: node-floor -->", "Needs Node 22."],
        source: SOURCE,
      }),
    );
    expect(result?.outcome).toBe("pass");
    expect(result?.findings).toBeUndefined();
  });

  it("reports a moved range as info, with the new src and the refresh command", async () => {
    const { result, findings } = await run(
      scaffold({
        body: [`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Needs Node 22."],
        source: "# license\n# header\n" + SOURCE,
      }),
    );
    expect(result?.outcome).toBe("pass");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "citations/moved", severity: "info", line: 9 });
    expect(findings[0]?.message).toContain("src/install.sh:5-6");
    expect(findings[0]?.message).toContain("cite refresh docs/page.md");
  });

  it("reports a changed range at the eval's severity, quoting the claim", async () => {
    const corpus = {
      body: [`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Needs Node 22."],
      source: SOURCE.replace("need node 22", "need node 24"),
    };
    const warned = await run(scaffold(corpus));
    expect(warned.result?.outcome).toBe("pass");
    expect(warned.findings[0]).toMatchObject({ ruleId: "citations/changed", severity: "warning", line: 9 });
    expect(warned.findings[0]?.message).toContain('Claim: "Needs Node 22."');
    expect(warned.findings[0]?.message).toContain("src/install.sh:3-4");

    const failed = await run(scaffold({ ...corpus, severity: "error" }));
    expect(failed.result?.outcome).toBe("fail");
    expect(failed.report.exitCode).toBe(1);
  });

  it("anchors a frontmatter entry with no reference to its own line", async () => {
    const { findings } = await run(
      scaffold({
        frontmatter: ["cites:", "  - id: whole", "    src: src/install.sh", `    sha256: ${HASH}`],
        body: ["No comment here."],
        source: SOURCE,
      }),
    );
    // `- id: whole` sits on line 6 of the page.
    expect(findings[0]).toMatchObject({ ruleId: "citations/changed", line: 6 });
  });

  describe("with a commit", () => {
    const changed = {
      body: [`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} commit=${COMMIT} -->`, "Needs Node 22."],
      source: SOURCE.replace("need node 22", "need node 24"),
    };

    it("carries the commit subjects and the diff command on a changed citation", async () => {
      const { findings } = await run(scaffold(changed), fakeGit(SOURCE, ["Require Node 24", "Tidy"]));
      expect(ruleIds(findings)).toEqual(["citations/changed"]);
      expect(findings[0]?.message).toContain(`since ${COMMIT}`);
      expect(findings[0]?.message).toContain('"Require Node 24"');
      expect(findings[0]?.message).toContain(`git diff ${COMMIT} HEAD -- src/install.sh`);
    });

    it("fails at any severity when the hash was never true at that commit", async () => {
      const { result, findings } = await run(
        scaffold({
          body: [`<!-- cite: src=src/install.sh:3-4 sha256=${"0".repeat(64)} commit=${COMMIT} -->`, "Claim."],
          source: SOURCE,
        }),
        fakeGit(SOURCE),
      );
      expect(ruleIds(findings)).toEqual(["citations/never-true"]);
      expect(findings[0]?.diagnostic).toBe(true);
      expect(findings[0]?.severity).toBe("warning");
      expect(result?.outcome).toBe("fail");
    });

    it("adds an info finding when the repository cannot show the commit", async () => {
      const { result, findings } = await run(scaffold(changed), fakeGit(undefined));
      expect(ruleIds(findings)).toEqual(["citations/changed", "citations/commit-unresolved"]);
      expect(findings[1]?.severity).toBe("info");
      expect(findings[1]?.message).toContain("shallow clone");
      expect(result?.outcome).toBe("pass");
    });

    it("says once per page that git is unavailable, and still classifies", async () => {
      const { result, findings } = await run(scaffold(changed), noGit);
      expect(ruleIds(findings)).toEqual(["citations/changed", "citations/no-git"]);
      expect(findings[1]?.severity).toBe("info");
      expect(result?.outcome).toBe("pass");
    });
  });

  it("reports a missing source at the eval's severity", async () => {
    const { findings } = await run(
      scaffold({ body: [`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`, "Claim."] }),
    );
    expect(findings[0]).toMatchObject({ ruleId: "citations/missing", severity: "warning" });
    expect(findings[0]?.diagnostic).toBeUndefined();
  });

  it("reports an unminted citation, naming the command that mints it", async () => {
    const { findings } = await run(
      scaffold({ body: ["<!-- cite: src=src/install.sh:3-4 -->", "Claim."], source: SOURCE }),
    );
    expect(findings[0]).toMatchObject({ ruleId: "citations/unminted", severity: "warning" });
    expect(findings[0]?.message).toContain("cite refresh");
  });

  it("warns about a reference that names no citation", async () => {
    const { findings } = await run(scaffold({ body: ["<!-- cite: nope -->", "Claim."] }));
    expect(findings[0]).toMatchObject({ ruleId: "citations/reference-orphan", severity: "warning", line: 9 });
  });

  describe("quote", () => {
    const quoted = (block: string[]) => ({
      body: [
        `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} quote -->`,
        "The check is:",
        "",
        "```sh",
        ...block,
        "```",
      ],
      source: SOURCE,
    });

    it("passes when the code block after the comment matches the cited lines", async () => {
      const { result } = await run(scaffold(quoted(["need node 22", "or later"])));
      expect(result?.findings).toBeUndefined();
      expect(result?.outcome).toBe("pass");
    });

    it("reports a hand-edited copy even though the source is current", async () => {
      const { findings } = await run(scaffold(quoted(["need node 22", "or newer"])));
      // Anchored to the fence, which is where the fix goes.
      expect(findings[0]).toMatchObject({ ruleId: "citations/quote-drift", severity: "warning", line: 12 });
    });

    it("reports a quote citation with no code block after it", async () => {
      const { findings } = await run(
        scaffold({
          body: [`<!-- cite: src=src/install.sh:3-4 sha256=${HASH} quote -->`, "No block follows."],
          source: SOURCE,
        }),
      );
      expect(findings[0]).toMatchObject({ ruleId: "citations/quote-missing", severity: "warning" });
    });

    it("does not look past the next citation comment for the block", async () => {
      const { findings } = await run(
        scaffold({
          body: [
            `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} quote -->`,
            "Nothing here.",
            `<!-- cite: src=src/install.sh:3-4 sha256=${HASH} -->`,
            "```sh",
            "need node 22",
            "or later",
            "```",
          ],
          source: SOURCE,
        }),
      );
      expect(ruleIds(findings)).toEqual(["citations/quote-missing"]);
    });
  });

  describe("URL sources", () => {
    const url = "https://github.com/o/r/blob/main/src/install.sh#L3-L4";
    const fetchOf = (status: number, body: string): FetchLike => () =>
      Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(body) });

    it("passes a current URL citation through the injected fetch", async () => {
      const { result } = await run(
        scaffold({ body: [`<!-- cite: src=${url} sha256=${HASH} -->`, "Claim."] }),
        fakeGit(undefined),
        fetchOf(200, SOURCE),
      );
      expect(result?.outcome).toBe("pass");
      expect(result?.findings).toBeUndefined();
    });

    it("fails at any severity when the URL cannot be reached", async () => {
      const { result, findings } = await run(
        scaffold({ body: [`<!-- cite: src=${url} sha256=${HASH} -->`, "Claim."] }),
        fakeGit(undefined),
        fetchOf(503, ""),
      );
      expect(findings[0]).toMatchObject({ ruleId: "citations/unreachable", diagnostic: true });
      expect(result?.outcome).toBe("fail");
    });

    it("skips URL sources as info when options.network is false", async () => {
      let fetched = false;
      const fetch: FetchLike = () => {
        fetched = true;
        return fetchOf(200, SOURCE)("");
      };
      const { result, findings } = await run(
        scaffold({
          body: [`<!-- cite: src=${url} sha256=${HASH} -->`, "Claim."],
          options: ["network: false"],
        }),
        fakeGit(undefined),
        fetch,
      );
      expect(fetched).toBe(false);
      expect(findings[0]).toMatchObject({ ruleId: "citations/network-off", severity: "info" });
      expect(result?.outcome).toBe("pass");
    });
  });

  it("rejects an unknown option before anything runs", async () => {
    const { errors } = await run(scaffold({ body: ["x"], options: ["netwrok: false"] }));
    expect(errors[0]?.message).toContain("netwrok");
  });
});
