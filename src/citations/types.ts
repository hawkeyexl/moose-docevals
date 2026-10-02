/**
 * A resolved citation: one entry from a page's `cites` list or one inline
 * body comment, normalized into the same shape (ADR 01045). Nothing past
 * `resolvePage` distinguishes the two forms except through `origin`, which
 * `cite refresh` reads to know *where* to write.
 */
import type { CommentSpan } from "./comments.js";
import type { SourceSpec } from "./hash.js";

/** A body comment that names this citation, and the sentence beside it. */
export interface CitationAnchor {
  /** 1-based file line of the comment. */
  line: number;
  /** The sentence the comment sits above or beside; empty when none. */
  claim: string;
  /** 1-based file line of the claim. */
  claimLine: number;
}

export interface Citation {
  /** Frontmatter `id`, inline `id=`, or `inline-<line>` for an unnamed inline one. */
  id: string;
  /** `src` as written. */
  src: string;
  spec: SourceSpec;
  /** Absent means unminted: the citation has not been hashed yet. */
  sha256?: string;
  /**
   * The commit the hash was minted at: the entry's own `commit`, else the
   * page's `cite-commit`. Absent when neither is written, and when the entry
   * says `commit: none`.
   */
  commit?: string;
  /**
   * Where `commit` — or its explicit absence — was written. `entry` with no
   * `commit` is the `none` case: the citation opted out of the page default.
   * `cite refresh` reads this to know whether there is an entry-level value
   * to replace, or an inherited one it must override.
   */
  commitSource?: "entry" | "page";
  quote: boolean;
  origin: "frontmatter" | "inline";
  /** 1-based file line of the declaration: the entry, or the comment. */
  line: number;
  /** Frontmatter entries: position in `cites`, for line pointers and edits. */
  index?: number;
  /** Inline citations: the comment, for rewriting in place. */
  comment?: { line: number; syntax: "html" | "mdx"; span: CommentSpan };
  /**
   * Where findings point. An inline citation anchors to its own comment; a
   * frontmatter entry anchors to every reference comment that names it, and
   * to nothing when none does (a whole-file citation needs no sentence).
   */
  anchors: CitationAnchor[];
}

/**
 * The `commit` value that means "no commit, and do not inherit the page's".
 * A hash minted without a commit (`--no-commit`, a branch-pinned URL) on a
 * page with `cite-commit` would otherwise inherit a commit it was never
 * checked against, and the next change would read as never-true.
 */
export const NO_COMMIT = "none";

export interface PageCitations {
  /** The page's `cite-commit`, when it has one. */
  defaultCommit?: string;
  entries: Citation[];
  /** Reference comments naming an id no entry has. */
  orphans: { id: string; line: number }[];
}

/** A fresh empty set, never a shared instance a caller could mutate. */
export function noCitations(): PageCitations {
  return { entries: [], orphans: [] };
}
