/**
 * The three git questions a citation asks, over the injected `ExecFn`:
 * what is HEAD, what did a path contain at a commit, and which commits have
 * touched it since. Every answer is a result, never a throw — the grader
 * turns a failure into a finding, and the command turns it into a message.
 *
 * Same shape as the private `git()` in `core/since.ts`: a spawn failure and
 * a timeout are named once, and a non-zero exit is left to the caller because
 * "no such commit" and "not a repository" send the reader different places.
 */
import type { ExecFn, ExecResult } from "../graders/types.js";
import { outputTail } from "../graders/exec.js";

const GIT_TIMEOUT_MS = 30_000;

export type GitResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "no-git" | "timeout" | "failed" | "bad-ref"; detail: string };

async function git(exec: ExecFn, args: string[], root: string): Promise<GitResult<ExecResult>> {
  const result = await exec(["git", ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  if (result.spawnError) {
    return { ok: false, reason: "no-git", detail: `could not run git (${result.spawnError})` };
  }
  if (result.timedOut) {
    return {
      ok: false,
      reason: "timeout",
      detail: `git ${args.join(" ")} took longer than ${GIT_TIMEOUT_MS / 1000}s`,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: "failed",
      detail: outputTail(result) || `git exited ${String(result.code)}`,
    };
  }
  return { ok: true, value: result };
}

/**
 * A commit a page wrote is content, and content that parses as a git option
 * is not a commit. The schema already pins the hex shape; this guards the
 * library caller who never went through it.
 */
function badRef(commit: string): GitResult<never> | undefined {
  if (commit.trim() === "" || commit.startsWith("-")) {
    return { ok: false, reason: "bad-ref", detail: `"${commit}" is not a commit` };
  }
  return undefined;
}

/** The full sha of HEAD. */
export async function gitHead(exec: ExecFn, root: string): Promise<GitResult<string>> {
  const r = await git(exec, ["rev-parse", "HEAD"], root);
  return r.ok ? { ok: true, value: r.value.stdout.trim() } : r;
}

/**
 * The content of `path` at `commit`. The path is relative to `root`, not to
 * the repository top level: `<rev>:./<path>` is git's own spelling for that.
 * An absolute path is handed over as written and fails unless git can map it.
 */
export async function gitShow(
  exec: ExecFn,
  root: string,
  commit: string,
  path: string,
): Promise<GitResult<string>> {
  const bad = badRef(commit);
  if (bad) return bad;
  const spec = /^(?:[A-Za-z]:)?[\\/]/.test(path) ? `${commit}:${path}` : `${commit}:./${path}`;
  const r = await git(exec, ["--no-pager", "show", spec], root);
  return r.ok ? { ok: true, value: r.value.stdout } : r;
}

/** Subjects of the commits that touched `path` after `commit`, newest first. */
export async function gitSubjectsSince(
  exec: ExecFn,
  root: string,
  commit: string,
  path: string,
): Promise<GitResult<string[]>> {
  const bad = badRef(commit);
  if (bad) return bad;
  // NUL-terminated subjects: a subject can contain anything but NUL.
  const r = await git(
    exec,
    ["--no-pager", "log", "--format=%s%x00", `${commit}..HEAD`, "--", path],
    root,
  );
  if (!r.ok) return r;
  return {
    ok: true,
    value: r.value.stdout
      .split("\0")
      .map((s) => s.replace(/^\s+/, ""))
      .filter((s) => s !== ""),
  };
}
