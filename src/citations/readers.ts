/**
 * The readers a page's citations are classified with: the file system or
 * `fetch` for the source as it is now, and git (or a re-pointed GitHub URL)
 * for the source as it was at the recorded commit. One construction, shared
 * by the grader and by `cite refresh`, so both reach the same verdict.
 *
 * Git is consulted lazily and, once found missing, never again for this
 * set of readers: the caller reports that once rather than per citation.
 */
import type { ExecFn } from "../graders/types.js";
import type { ClassifyReaders } from "./classify.js";
import { gitShow, gitSubjectsSince } from "./git.js";
import { readSource, readUrlAtCommit, type FetchLike, type SourceReaders } from "./source.js";

export interface ReaderOptions {
  /** Discovery root; relative sources resolve against it. */
  root: string;
  exec: ExecFn;
  fetch?: FetchLike;
  /** Whether URL sources may be fetched. */
  network: boolean;
}

export interface PageReaders {
  readers: ClassifyReaders;
  /** True once a git call found no git binary. */
  gitMissing: () => boolean;
}

export function makeReaders(opts: ReaderOptions): PageReaders {
  const sources: SourceReaders = { root: opts.root, fetch: opts.fetch, network: opts.network };
  let gitMissing = false;
  const readers: ClassifyReaders = {
    readSource: (spec) => readSource(spec, sources),
    readAtCommit: async (spec, commit) => {
      if (spec.kind === "url") {
        return (
          (await readUrlAtCommit(spec, commit, sources)) ?? {
            ok: false,
            status: "unreachable",
            detail: "a plain URL has no history to read",
          }
        );
      }
      if (gitMissing) return { ok: false, status: "unreachable", detail: "git unavailable" };
      const r = await gitShow(opts.exec, opts.root, commit, spec.path);
      if (r.ok) return { ok: true, text: r.value };
      if (r.reason === "no-git") gitMissing = true;
      return { ok: false, status: "unreachable", detail: r.detail };
    },
    subjectsSince: async (spec, commit) => {
      if (spec.kind === "url" || gitMissing) return undefined;
      const r = await gitSubjectsSince(opts.exec, opts.root, commit, spec.path);
      if (r.ok) return r.value;
      if (r.reason === "no-git") gitMissing = true;
      return undefined;
    },
  };
  return { readers, gitMissing: () => gitMissing };
}
