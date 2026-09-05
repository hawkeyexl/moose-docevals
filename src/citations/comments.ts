/**
 * The body side of a citation: the comment that anchors a sentence.
 *
 * A comment is either a *reference* to a frontmatter entry (`cite: <id>`) or
 * an *inline citation* carrying the entry itself as `key=value` tokens
 * (`cite: src=scripts/install.sh:3-4 sha256=… commit=…`). The keys are the
 * frontmatter entry's fields, so there is one vocabulary; `resolvePage`
 * validates an inline entry against the same schema definition the
 * frontmatter list uses, and nothing downstream knows which form a citation
 * came from (ADR 01045).
 *
 * Two comment syntaxes, because MDX forbids HTML comments: the HTML form,
 * `<!-- cite: node-floor -->`, for Markdown, and the same tokens inside a JSX
 * comment (open brace, slash, star ... star, slash, close brace) for MDX.
 *
 * The comment sits on the line above the sentence it supports, or at the end
 * of it. The sentence — the *claim* — is what a finding quotes back, so the
 * frontmatter never has to repeat it.
 *
 * Comments inside a fenced code block or an inline code span are ignored. A
 * page that documents the syntax shows it in code, and must not thereby
 * declare citations it never meant.
 */

export interface CommentSpan {
  /** Character offset of the first token in the file. */
  start: number;
  /** Character offset just past the last token. */
  end: number;
}

interface CommentBase {
  /** 1-based file line of the comment. */
  line: number;
  /** Which comment syntax was used, so a rewrite keeps it. */
  syntax: "html" | "mdx";
  /** Where the token text sits, for rewriting in place. */
  span: CommentSpan;
  /** The sentence the comment anchors; empty when none is adjacent. */
  claim: string;
  /** 1-based file line of the claim (the comment's own line when empty). */
  claimLine: number;
}

export type ScannedCite =
  | (CommentBase & { kind: "reference"; id: string })
  | (CommentBase & { kind: "inline"; entry: Record<string, unknown> })
  | (CommentBase & { kind: "invalid"; reason: string });

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const COMMENT = /(<!--|\{\/\*)(\s*cite:\s*)([^\n]*?)(\s*)(-->|\*\/\})/g;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CODE_SPAN = /`+[^`\n]*`+/g;

/** Every cite comment in `content`, in file order. */
export function scanCiteComments(content: string): ScannedCite[] {
  const found: ScannedCite[] = [];
  // Split keeping the terminators, so offsets stay exact under CRLF.
  const lines = content.split(/(?<=\n)/);
  let offset = 0;
  let fence: { char: string; length: number } | undefined;

  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r?\n$/, "");
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length
      ) {
        fence = undefined;
      }
      offset += rawLine.length;
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      offset += rawLine.length;
      continue;
    }

    const spans = [...line.matchAll(CODE_SPAN)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    for (const m of line.matchAll(COMMENT)) {
      const at = m.index;
      if (spans.some(([s, e]) => at >= s! && at < e!)) continue;
      const [whole, open, lead, body] = m as unknown as [string, string, string, string];
      const tokenStart = offset + at + open.length + lead.length;
      const base: CommentBase = {
        line: i + 1,
        syntax: open === "<!--" ? "html" : "mdx",
        span: { start: tokenStart, end: tokenStart + body.length },
        ...claimFor(lines, i, line.slice(0, at) + line.slice(at + whole.length)),
      };
      found.push(classify(base, body));
    }
    offset += rawLine.length;
  }
  return found;
}

function claimFor(
  lines: string[],
  index: number,
  sameLineRest: string,
): { claim: string; claimLine: number } {
  const same = sameLineRest.trim();
  if (same !== "") return { claim: same, claimLine: index + 1 };
  for (let j = index + 1; j < lines.length; j++) {
    const text = lines[j]!.replace(/\r?\n$/, "");
    if (text.trim() === "") continue;
    // The next thing is a code block, not a sentence: no claim.
    if (FENCE.test(text)) return { claim: "", claimLine: index + 1 };
    return { claim: text.trim(), claimLine: j + 1 };
  }
  return { claim: "", claimLine: index + 1 };
}

function classify(base: CommentBase, body: string): ScannedCite {
  const tokens = body.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) {
    return { ...base, kind: "invalid", reason: "empty cite comment" };
  }
  const looksInline = tokens.some((t) => t.includes("=") || t === "quote");
  if (!looksInline) {
    if (tokens.length === 1 && KEBAB.test(tokens[0]!)) {
      return { ...base, kind: "reference", id: tokens[0]! };
    }
    return {
      ...base,
      kind: "invalid",
      reason:
        tokens.length === 1
          ? `"${tokens[0]!}" is not a kebab-case citation id`
          : `expected one citation id or key=value tokens, got "${body.trim()}"`,
    };
  }
  const parsed = parseInlineTokens(tokens);
  if (!parsed.ok) return { ...base, kind: "invalid", reason: parsed.error };
  return { ...base, kind: "inline", entry: parsed.entry };
}

/**
 * `key=value` tokens into a plain object. Only `quote` may stand alone (it
 * means `quote=true`). Unknown keys are kept: the schema definition rejects
 * them, with the same message a misspelled frontmatter field gets.
 */
export function parseInlineTokens(
  tokens: string[],
): { ok: true; entry: Record<string, unknown> } | { ok: false; error: string } {
  const entry: Record<string, unknown> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq === -1) {
      if (token === "quote") {
        entry.quote = true;
        continue;
      }
      return { ok: false, error: `"${token}" is not a key=value token` };
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "") return { ok: false, error: `"${token}" has no key` };
    if (key in entry) return { ok: false, error: `"${key}" is given twice` };
    if (key === "quote") {
      if (value !== "true" && value !== "false") {
        return { ok: false, error: "quote must be true or false" };
      }
      entry.quote = value === "true";
      continue;
    }
    entry[key] = value;
  }
  return { ok: true, entry };
}

/**
 * The first fenced code block whose opening fence is on a line after
 * `fromLine` and at or before `toLine` (both 1-based). Returns the block's
 * content lines joined by LF, and the fence's line.
 */
export function fencedBlockAfter(
  lines: string[],
  fromLine: number,
  toLine: number,
): { text: string; line: number } | undefined {
  for (let i = fromLine; i < Math.min(toLine, lines.length); i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const char = open[1]![0]!;
    const length = open[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const close = FENCE.exec(lines[j]!);
      if (close && close[1]![0] === char && close[1]!.length >= length) {
        return { text: lines.slice(i + 1, j).join("\n"), line: i + 1 };
      }
    }
    return undefined;
  }
  return undefined;
}
