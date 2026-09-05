/**
 * The drift classifier (ADR 01045): CURRENT, MOVED, CHANGED, MISSING, plus
 * the states about the citation itself — unminted, never-true, and a commit
 * the repository cannot show. Pure over injected readers, so every case here
 * runs in memory: no file, no network, no git.
 *
 * The git and fetch adapters that feed it are tested beside it, against a
 * fake `ExecFn` and a fake `fetch`, per the hermetic-suite rule.
 */
import { describe, it, expect } from "vitest";
import { classifyCitation, type ClassifyReaders } from "../../src/citations/classify.js";
import { hashRange, parseSrc, type SourceSpec } from "../../src/citations/hash.js";
import type { Citation } from "../../src/citations/types.js";
import { gitHead, gitShow, gitSubjectsSince } from "../../src/citations/git.js";
import { readSource, type FetchLike } from "../../src/citations/source.js";
import type { ExecFn, ExecResult } from "../../src/graders/types.js";

const SOURCE = ["#!/bin/sh", "set -e", "need node 22", "or later", "echo done"].join("\n") + "\n";
const RANGE = { start: 3, end: 4 };
const HASH = hashRange(SOURCE, RANGE)!;

function cite(src: string, extra: Partial<Citation> = {}): Citation {
  const parsed = parseSrc(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    id: "c",
    src,
    spec: parsed.spec,
    sha256: HASH,
    quote: false,
    origin: "inline",
    line: 1,
    anchors: [],
    ...extra,
  };
}

/** Readers over an in-memory "file system" and an in-memory history. */
function readers(
  files: Record<string, string>,
  history: Record<string, Record<string, string>> = {},
  subjects: string[] = [],
): ClassifyReaders {
  return {
    readSource: (spec: SourceSpec) => {
      const key = spec.kind === "file" ? spec.path : spec.fetchUrl;
      const text = files[key];
      return Promise.resolve(
        text === undefined ? { ok: false, status: "missing", detail: `${key} not found` } : { ok: true, text },
      );
    },
    readAtCommit: (spec, commit) => {
      const key = spec.kind === "file" ? spec.path : spec.fetchUrl;
      const text = history[commit]?.[key];
      return Promise.resolve(
        text === undefined
          ? { ok: false, status: "unreachable", detail: `no ${commit}` }
          : { ok: true, text },
      );
    },
    subjectsSince: () => Promise.resolve(subjects),
  };
}

describe("classifyCitation", () => {
  it("is current when the range still hashes to the recorded value", async () => {
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": SOURCE }));
    expect(r.status).toBe("current");
    expect(r.sourceLines).toHaveLength(5);
  });

  it("is current for a whole-file citation", async () => {
    const c = cite("a.sh", { sha256: hashRange(SOURCE) });
    expect((await classifyCitation(c, readers({ "a.sh": SOURCE }))).status).toBe("current");
  });

  it("is moved when the same lines sit elsewhere in the file, and says where", async () => {
    const shifted = "# license\n# header\n" + SOURCE;
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": shifted }));
    expect(r.status).toBe("moved");
    expect(r.movedTo).toEqual({ start: 5, end: 6 });
    expect(r.movedMatches).toBe(1);
  });

  it("is moved when the range now sits past the end of the original file length", async () => {
    const shifted = "a\nb\nc\nd\ne\nf\nneed node 22\nor later\n";
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": shifted }));
    expect(r.status).toBe("moved");
    expect(r.movedTo).toEqual({ start: 7, end: 8 });
  });

  it("reports the match count when the lines appear more than once", async () => {
    const twice = "x\ny\n" + SOURCE + SOURCE;
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": twice }));
    expect(r.status).toBe("moved");
    expect(r.movedMatches).toBe(2);
    expect(r.movedTo?.start).toBe(5);
  });

  it("is changed when the lines differ and appear nowhere else", async () => {
    const edited = SOURCE.replace("need node 22", "need node 24");
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": edited }));
    expect(r.status).toBe("changed");
  });

  it("is changed when the file got shorter than the range", async () => {
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": "one\ntwo\n" }));
    expect(r.status).toBe("changed");
  });

  it("is changed, never moved, for a whole-file citation", async () => {
    const c = cite("a.sh", { sha256: hashRange(SOURCE) });
    const r = await classifyCitation(c, readers({ "a.sh": "# header\n" + SOURCE }));
    expect(r.status).toBe("changed");
  });

  it("is missing when the source cannot be read", async () => {
    const r = await classifyCitation(cite("gone.sh:1"), readers({}));
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("gone.sh");
  });

  it("is unminted when there is no hash, without reading the source", async () => {
    let reads = 0;
    const rs = readers({ "a.sh": SOURCE });
    const spy: ClassifyReaders = {
      ...rs,
      readSource: (spec) => {
        reads++;
        return rs.readSource(spec);
      },
    };
    const r = await classifyCitation(cite("a.sh:3-4", { sha256: undefined }), spy);
    expect(r.status).toBe("unminted");
    expect(reads).toBe(0);
  });

  it("skips the moved search on a very large file and says so", async () => {
    const huge = "x\n".repeat(1_100_000) + SOURCE;
    const r = await classifyCitation(cite("a.sh:3-4"), readers({ "a.sh": huge }));
    expect(r.status).toBe("changed");
    expect(r.detail).toMatch(/too large/);
  });

  describe("with a commit", () => {
    it("lists the commit subjects on a changed citation", async () => {
      const edited = SOURCE.replace("need node 22", "need node 24");
      const r = await classifyCitation(
        cite("a.sh:3-4", { commit: "4d1e7c0" }),
        readers({ "a.sh": edited }, { "4d1e7c0": { "a.sh": SOURCE } }, ["Require Node 24", "Tidy"]),
      );
      expect(r.status).toBe("changed");
      expect(r.subjects).toEqual(["Require Node 24", "Tidy"]);
      expect(r.neverTrue).toBeUndefined();
    });

    it("is never-true when the range at that commit does not hash to the record either", async () => {
      const edited = SOURCE.replace("need node 22", "need node 24");
      const r = await classifyCitation(
        cite("a.sh:3-4", { commit: "4d1e7c0", sha256: "0".repeat(64) }),
        readers({ "a.sh": edited }, { "4d1e7c0": { "a.sh": SOURCE } }),
      );
      expect(r.status).toBe("changed");
      expect(r.neverTrue).toBe(true);
    });

    it("is not never-true when the bytes existed elsewhere at the commit (a moved range)", async () => {
      // `cite refresh` rewrote 3-4 to 5-6 after a header landed, and left the
      // commit alone. At that commit the lines were still at 3-4.
      const shifted = "# license\n# header\n" + SOURCE.replace("need node 22", "need node 24");
      const c = cite("a.sh:5-6", { commit: "4d1e7c0" });
      const r = await classifyCitation(c, readers({ "a.sh": shifted }, { "4d1e7c0": { "a.sh": SOURCE } }));
      expect(r.status).toBe("changed");
      expect(r.neverTrue).toBeUndefined();
    });

    it("does not consult history when the citation is current", async () => {
      let historyReads = 0;
      const rs = readers({ "a.sh": SOURCE });
      const spy: ClassifyReaders = {
        ...rs,
        readAtCommit: (spec, commit) => {
          historyReads++;
          return rs.readAtCommit!(spec, commit);
        },
      };
      await classifyCitation(cite("a.sh:3-4", { commit: "4d1e7c0" }), spy);
      expect(historyReads).toBe(0);
    });

    it("reports a commit the repository cannot show, and keeps the drift verdict", async () => {
      const edited = SOURCE.replace("need node 22", "need node 24");
      const r = await classifyCitation(
        cite("a.sh:3-4", { commit: "4d1e7c0" }),
        readers({ "a.sh": edited }, {}),
      );
      expect(r.status).toBe("changed");
      expect(r.commitUnresolved).toContain("4d1e7c0");
      expect(r.neverTrue).toBeUndefined();
    });

    it("works without history readers at all, as when git is absent", async () => {
      const edited = SOURCE.replace("need node 22", "need node 24");
      const rs = readers({ "a.sh": edited });
      const r = await classifyCitation(cite("a.sh:3-4", { commit: "4d1e7c0" }), {
        readSource: rs.readSource,
      });
      expect(r.status).toBe("changed");
      expect(r.subjects).toBeUndefined();
    });
  });
});

const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false };

function fakeGit(responses: (cmd: string[]) => Partial<ExecResult>): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = (cmd) => {
    calls.push(cmd);
    return Promise.resolve({ ...OK, ...responses(cmd) });
  };
  return { exec, calls };
}

describe("git adapters", () => {
  it("gitHead returns the trimmed sha", async () => {
    const { exec, calls } = fakeGit(() => ({ stdout: "4d1e7c0abc\n" }));
    expect(await gitHead(exec, "/repo")).toEqual({ ok: true, value: "4d1e7c0abc" });
    expect(calls[0]).toEqual(["git", "rev-parse", "HEAD"]);
  });

  it("gitShow reads a path relative to the working directory, at a commit", async () => {
    const { exec, calls } = fakeGit(() => ({ stdout: "content\n" }));
    expect(await gitShow(exec, "/repo", "4d1e7c0", "scripts/install.sh")).toEqual({
      ok: true,
      value: "content\n",
    });
    // `./` makes git resolve the path against cwd, not the repository root.
    expect(calls[0]).toEqual(["git", "--no-pager", "show", "4d1e7c0:./scripts/install.sh"]);
  });

  it("gitShow reports a commit or path git cannot resolve", async () => {
    const { exec } = fakeGit(() => ({ code: 128, stderr: "fatal: invalid object name" }));
    const r = await gitShow(exec, "/repo", "4d1e7c0", "a.sh");
    expect(r).toMatchObject({ ok: false, reason: "failed" });
  });

  it("gitSubjectsSince lists subjects newest first, from a NUL-separated log", async () => {
    const { exec, calls } = fakeGit(() => ({ stdout: "Tidy\0Require Node 24\0" }));
    expect(await gitSubjectsSince(exec, "/repo", "4d1e7c0", "a.sh")).toEqual({
      ok: true,
      value: ["Tidy", "Require Node 24"],
    });
    expect(calls[0]).toEqual([
      "git",
      "--no-pager",
      "log",
      "--format=%s%x00",
      "4d1e7c0..HEAD",
      "--",
      "a.sh",
    ]);
  });

  it("names a missing git binary once, as its own reason", async () => {
    const { exec } = fakeGit(() => ({ spawnError: "ENOENT" }));
    expect(await gitHead(exec, "/repo")).toMatchObject({ ok: false, reason: "no-git" });
  });

  it("refuses a commit that looks like an option", async () => {
    const { exec, calls } = fakeGit(() => ({ stdout: "x" }));
    const r = await gitShow(exec, "/repo", "--output=x", "a.sh");
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("readSource over fetch", () => {
  const fetchOf = (status: number, body: string): FetchLike => () =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });

  const url = () => {
    const p = parseSrc("https://github.com/o/r/blob/main/src/x.ts#L3-L9");
    if (!p.ok) throw new Error(p.error);
    return p.spec;
  };

  it("fetches the raw URL", async () => {
    let fetched = "";
    const fetch: FetchLike = (u) => {
      fetched = u;
      return fetchOf(200, "body")(u);
    };
    const r = await readSource(url(), { root: "/repo", fetch, network: true });
    expect(r).toEqual({ ok: true, text: "body" });
    expect(fetched).toBe("https://raw.githubusercontent.com/o/r/main/src/x.ts");
  });

  it("reports a 404 as missing", async () => {
    const r = await readSource(url(), { root: "/repo", fetch: fetchOf(404, ""), network: true });
    expect(r).toMatchObject({ ok: false, status: "missing" });
  });

  it("reports any other failure as unreachable", async () => {
    const failing: FetchLike = () => Promise.reject(new Error("ECONNRESET"));
    const r = await readSource(url(), { root: "/repo", fetch: failing, network: true });
    expect(r).toMatchObject({ ok: false, status: "unreachable", detail: expect.stringContaining("ECONNRESET") });
    const r500 = await readSource(url(), { root: "/repo", fetch: fetchOf(500, ""), network: true });
    expect(r500).toMatchObject({ ok: false, status: "unreachable" });
  });

  it("does not fetch when the network is off", async () => {
    let fetched = false;
    const fetch: FetchLike = () => {
      fetched = true;
      return fetchOf(200, "")("");
    };
    const r = await readSource(url(), { root: "/repo", fetch, network: false });
    expect(r).toMatchObject({ ok: false, status: "network-off" });
    expect(fetched).toBe(false);
  });

  it("reports a missing local file without touching fetch", async () => {
    const p = parseSrc("definitely/not/here.txt");
    if (!p.ok) throw new Error(p.error);
    const r = await readSource(p.spec, { root: "/nowhere", network: true });
    expect(r).toMatchObject({ ok: false, status: "missing" });
  });
});
