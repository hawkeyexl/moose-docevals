/**
 * Minting a citation: hashing the cited range as it is now, and recording
 * the commit that content belongs to (ADR 01046).
 *
 * The commit is what makes a later never-true check possible, so it must be
 * *true*: the bytes hashed are the bytes at that commit. A source with
 * uncommitted edits, or one git does not track, is refused rather than
 * stamped with a HEAD it does not match — `--no-commit` is the explicit way
 * to mint without that guarantee.
 */
import type { ExecFn } from "../graders/types.js";
import { gitHead, gitShow } from "./git.js";
import { hashRange, normalizeLines, type SourceSpec } from "./hash.js";
import { readSource, type FetchLike } from "./source.js";

export interface MintOptions {
  root: string;
  exec: ExecFn;
  fetch?: FetchLike;
  /** Hash only; record no commit. */
  noCommit?: boolean;
}

export type MintResult =
  | { ok: true; sha256: string; commit?: string }
  | { ok: false; reason: string };

const SHA = /^[0-9a-f]{7,40}$/;

export async function mintCitation(spec: SourceSpec, opts: MintOptions): Promise<MintResult> {
  const read = await readSource(spec, { root: opts.root, fetch: opts.fetch, network: true });
  if (!read.ok) return { ok: false, reason: read.detail };
  const sha256 = hashRange(read.text, spec.range);
  if (sha256 === undefined) {
    const lines = normalizeLines(read.text).length;
    const r = spec.range;
    return {
      ok: false,
      reason: `range ${r?.start ?? "?"}-${r?.end ?? "?"} is past the end of the file (${lines} lines)`,
    };
  }
  if (opts.noCommit) return { ok: true, sha256 };

  if (spec.kind === "url") {
    // A GitHub URL pinned to a sha carries its own commit; a branch does not.
    const ref = spec.github?.ref;
    return ref !== undefined && SHA.test(ref) ? { ok: true, sha256, commit: ref } : { ok: true, sha256 };
  }

  const head = await gitHead(opts.exec, opts.root);
  if (!head.ok) {
    return {
      ok: false,
      reason:
        head.reason === "no-git"
          ? `git is not available (${head.detail}); pass --no-commit to mint without a commit`
          : `${opts.root} is not a git repository (${head.detail}); pass --no-commit to mint without a commit`,
    };
  }
  const committed = await gitShow(opts.exec, opts.root, "HEAD", spec.path);
  if (!committed.ok) {
    return {
      ok: false,
      reason: `${spec.path} is not tracked by git — commit it first, or pass --no-commit`,
    };
  }
  if (hashRange(committed.value, spec.range) !== sha256) {
    return {
      ok: false,
      reason:
        `${spec.path} has uncommitted changes, so a commit recorded now would not match ` +
        `the hash — commit first, or pass --no-commit`,
    };
  }
  return { ok: true, sha256, commit: head.value };
}
