/**
 * Rewriting an inline citation comment in place (ADR 01046).
 *
 * `cite refresh` mints an unminted comment, moves a range, or re-mints a
 * changed one. It does so by updating the tokens that change, inside the span
 * `scanCiteComments` recorded, and nothing else: a value is replaced where it
 * stands, and a new `sha256` or `commit` is inserted beside the token it
 * belongs with. Every other token, the author's token order, the spacing
 * between tokens, the comment's delimiters, the sentence beside it, and every
 * other byte of the file survive. This is the first place moose-docevals
 * edits a page body, so the promise is stated once here and tested by
 * diffing whole files.
 *
 * It does not re-serialize the comment. The first version did, in a fixed
 * field order, which silently dropped an explicit `quote=false` and reordered
 * tokens the author had written in another order.
 */
import type { CommentSpan } from "./comments.js";

export interface InlineEntryFields {
  id?: string;
  src: string;
  sha256?: string;
  commit?: string;
  quote?: boolean;
}

/**
 * `key=value` tokens in a fixed order, `quote` as a bare flag. For writing a
 * *new* comment (`cite add --inline`); an existing one is updated in place
 * with `updateInlineTokens`, never rebuilt with this.
 */
export function serializeInlineTokens(entry: InlineEntryFields): string {
  const tokens: string[] = [];
  if (entry.id !== undefined) tokens.push(`id=${entry.id}`);
  tokens.push(`src=${entry.src}`);
  if (entry.sha256 !== undefined) tokens.push(`sha256=${entry.sha256}`);
  if (entry.commit !== undefined) tokens.push(`commit=${entry.commit}`);
  if (entry.quote === true) tokens.push("quote");
  return tokens.join(" ");
}

/**
 * The fields `cite refresh` ever changes. `commit: null` removes the token:
 * a re-mint that records no commit must not leave the old one beside the new
 * hash, or the next change reads as "never true at that commit".
 */
export interface InlineUpdates {
  src?: string;
  sha256?: string;
  commit?: string | null;
}

// Applied in this order, so a freshly inserted `sha256` exists by the time
// `commit` looks for the token to sit beside.
const UPDATE_ORDER = ["src", "sha256", "commit"] as const;

/** Where a token that is not there yet goes: after the first of these found. */
const INSERT_AFTER: Record<(typeof UPDATE_ORDER)[number], readonly string[]> = {
  src: [],
  sha256: ["src"],
  commit: ["sha256", "src"],
};

/** The `key=value` token for `key`, anchored on a token boundary. */
function findToken(text: string, key: string): { start: number; end: number } | undefined {
  const match = new RegExp(`(^|\\s)${key}=\\S*`).exec(text);
  if (!match) return undefined;
  const lead = match[1] ?? "";
  return { start: match.index + lead.length, end: match.index + match[0].length };
}

/**
 * Update the token text of one inline citation. Existing values are replaced
 * where they stand; new tokens are inserted beside the one they belong with;
 * nothing else moves. Slices rather than `String.replace`, so a value is
 * written literally whatever characters it contains.
 */
export function updateInlineTokens(text: string, updates: InlineUpdates): string {
  let out = text;
  for (const key of UPDATE_ORDER) {
    const value = updates[key];
    if (value === undefined) continue;
    if (value === null) {
      // Remove the token and one separator: the whitespace before it, or
      // after it when it leads.
      const gone = findToken(out, key);
      if (gone) {
        out =
          gone.start > 0
            ? out.slice(0, gone.start).replace(/\s+$/, "") + out.slice(gone.end)
            : out.slice(gone.end).replace(/^\s+/, "");
      }
      continue;
    }
    const token = `${key}=${value}`;
    const existing = findToken(out, key);
    if (existing) {
      out = out.slice(0, existing.start) + token + out.slice(existing.end);
      continue;
    }
    const anchor = INSERT_AFTER[key]
      .map((k) => findToken(out, k))
      .find((found) => found !== undefined);
    out = anchor
      ? `${out.slice(0, anchor.end)} ${token}${out.slice(anchor.end)}`
      : `${out} ${token}`;
  }
  return out;
}

export interface InlineEdit {
  /** The span the comment's tokens occupied in `content` when it was scanned. */
  span: CommentSpan;
  updates: InlineUpdates;
}

/**
 * Apply several rewrites to one file. Spans are offsets into the *original*
 * content, so edits go in from the end of the file backwards: an earlier
 * edit changing length then cannot shift a later span.
 */
export function rewriteInlineCitations(content: string, edits: InlineEdit[]): string {
  let out = content;
  for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    const tokens = out.slice(edit.span.start, edit.span.end);
    out =
      out.slice(0, edit.span.start) +
      updateInlineTokens(tokens, edit.updates) +
      out.slice(edit.span.end);
  }
  return out;
}
