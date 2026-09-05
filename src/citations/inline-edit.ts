/**
 * Rewriting an inline citation comment in place (ADR 01046).
 *
 * `cite refresh` mints an unminted comment, moves a range, or re-mints a
 * changed one, and it does so by replacing the token text *inside* the
 * comment — the span `scanCiteComments` recorded — and nothing else. The
 * comment's own delimiters and spacing, the sentence beside it, and every
 * other byte of the file survive. This is the first place moose-docevals
 * edits a page body, so the promise is stated once here and tested by
 * diffing whole files.
 */
import type { CommentSpan } from "./comments.js";

export interface InlineEntryFields {
  id?: string;
  src: string;
  sha256?: string;
  commit?: string;
  quote?: boolean;
}

/** `key=value` tokens in a fixed order, `quote` as a bare flag. */
export function serializeInlineTokens(entry: InlineEntryFields): string {
  const tokens: string[] = [];
  if (entry.id !== undefined) tokens.push(`id=${entry.id}`);
  tokens.push(`src=${entry.src}`);
  if (entry.sha256 !== undefined) tokens.push(`sha256=${entry.sha256}`);
  if (entry.commit !== undefined) tokens.push(`commit=${entry.commit}`);
  if (entry.quote === true) tokens.push("quote");
  return tokens.join(" ");
}

export interface InlineEdit {
  /** The span the comment's tokens occupied in `content` when it was scanned. */
  span: CommentSpan;
  entry: InlineEntryFields;
}

/**
 * Apply several rewrites to one file. Spans are offsets into the *original*
 * content, so edits go in from the end of the file backwards: an earlier
 * edit changing length then cannot shift a later span.
 */
export function rewriteInlineCitations(content: string, edits: InlineEdit[]): string {
  let out = content;
  for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    out = out.slice(0, edit.span.start) + serializeInlineTokens(edit.entry) + out.slice(edit.span.end);
  }
  return out;
}
