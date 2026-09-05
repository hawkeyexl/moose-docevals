/**
 * The citation hashing rule, and the grammar of a citation's `src`.
 *
 * A citation records the sha256 of a range of lines in a source file so a
 * later run can tell whether those lines are still there (ADR 01045). Two
 * machines must mint the same hash for the same bytes, so the rule is stated
 * once here and every minting and checking path calls it:
 *
 *   read as UTF-8, strip a byte-order mark, split on `\r?\n`, drop the final
 *   empty element a trailing terminator leaves, take lines L1..L2 inclusive
 *   (1-based), join with `\n`, no trailing newline, trailing whitespace on
 *   each line preserved. No range means every line.
 *
 * `sha256` comes from the inference library by way of `judge/cache.ts`, so
 * this module and the judge cache spell the digest the same way.
 */
import { isAbsolute } from "node:path";
import { sha256 } from "../judge/cache.js";

/** 1-based, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

export interface FileSource {
  kind: "file";
  /** As written: relative to the discovery root, or absolute. */
  path: string;
  range?: LineRange;
}

export interface UrlSource {
  kind: "url";
  /** As written, without the range. */
  url: string;
  /** What is actually fetched: the raw file for a GitHub blob URL. */
  fetchUrl: string;
  /** Present for `https://github.com/<owner>/<repo>/blob/<ref>/<path>`. */
  github?: { owner: string; repo: string; ref: string; path: string };
  range?: LineRange;
}

export type SourceSpec = FileSource | UrlSource;

export type ParsedSrc =
  | { ok: true; spec: SourceSpec }
  | { ok: false; error: string };

/** Lines of `text` under the rule: BOM stripped, LF-normalized, no trailing empty line. */
export function normalizeLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The lines `range` selects, or undefined when it reaches past the file. */
export function sliceRange(lines: string[], range?: LineRange): string[] | undefined {
  if (range === undefined) return lines;
  if (range.end > lines.length) return undefined;
  return lines.slice(range.start - 1, range.end);
}

/** sha256 of lines joined with LF and no trailing newline. */
export function hashLines(lines: string[]): string {
  return sha256(lines.join("\n"));
}

/** sha256 of `range` within `text` under the rule; undefined past the file. */
export function hashRange(text: string, range?: LineRange): string | undefined {
  const selected = sliceRange(normalizeLines(text), range);
  return selected === undefined ? undefined : hashLines(selected);
}

const RANGE_SUFFIX = /:(\d+)(?:-(\d+))?$/;
const GITHUB_FRAGMENT = /^#?L(\d+)(?:-L?(\d+))?$/;
const GITHUB_BLOB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;

function rangeOf(start: string, end: string | undefined): LineRange | { error: string } {
  const s = Number.parseInt(start, 10);
  const e = end === undefined ? s : Number.parseInt(end, 10);
  if (s < 1) return { error: "line numbers start at 1" };
  if (e < s) return { error: `range ${s}-${e} ends before it starts` };
  return { start: s, end: e };
}

/**
 * Parse a `src` value: `path`, `path:L`, `path:L1-L2`, a GitHub blob URL with
 * a `#L1-L2` fragment, or any other https URL with a `:L1-L2` suffix.
 *
 * A path may be absolute. A citation reveals only whether the cited bytes are
 * the same, never what they are, so reading an absolute path is the low-risk
 * end of "content names a path on the machine running the eval".
 */
export function parseSrc(src: string): ParsedSrc {
  if (src.trim() === "") return { ok: false, error: "src is empty" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return parseUrl(src);

  const match = RANGE_SUFFIX.exec(src);
  // A drive letter is `X:` followed by a separator, never by digits, so the
  // suffix regex cannot mistake one for a range; but a path that *is* only a
  // drive-letter root has nothing after the colon and falls through cleanly.
  let path = src;
  let range: LineRange | undefined;
  if (match) {
    const r = rangeOf(match[1]!, match[2]);
    if ("error" in r) return { ok: false, error: r.error };
    range = r;
    path = src.slice(0, match.index);
  }
  if (path === "") return { ok: false, error: "src has a range but no path" };
  return { ok: true, spec: range ? { kind: "file", path, range } : { kind: "file", path } };
}

function parseUrl(src: string): ParsedSrc {
  if (!src.startsWith("https://")) {
    return { ok: false, error: "only https:// URLs can be cited" };
  }
  const hash = src.indexOf("#");
  const withoutFragment = hash === -1 ? src : src.slice(0, hash);
  const fragment = hash === -1 ? undefined : src.slice(hash);

  const blob = GITHUB_BLOB.exec(withoutFragment);
  if (blob) {
    const [, owner, repo, ref, path] = blob as unknown as [string, string, string, string, string];
    let range: LineRange | undefined;
    if (fragment !== undefined) {
      const m = GITHUB_FRAGMENT.exec(fragment);
      if (!m) return { ok: false, error: `unrecognized GitHub line fragment "${fragment}"` };
      const r = rangeOf(m[1]!, m[2]);
      if ("error" in r) return { ok: false, error: r.error };
      range = r;
    }
    const spec: UrlSource = {
      kind: "url",
      url: withoutFragment,
      fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
      github: { owner, repo, ref, path },
    };
    if (range) spec.range = range;
    return { ok: true, spec };
  }

  // A `:L1-L2` suffix. A port is `host:NNNN` *before* the path, so requiring
  // a path component after the host keeps `https://x.io:8080/spec.txt` whole.
  let url = withoutFragment;
  let range: LineRange | undefined;
  const m = RANGE_SUFFIX.exec(withoutFragment);
  if (m) {
    const candidate = withoutFragment.slice(0, m.index);
    let parsed: URL | undefined;
    try {
      parsed = new URL(candidate);
    } catch {
      parsed = undefined;
    }
    if (parsed && parsed.pathname.length > 1) {
      const r = rangeOf(m[1]!, m[2]);
      if ("error" in r) return { ok: false, error: r.error };
      range = r;
      url = candidate;
    }
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, error: `"${url}" is not a valid URL` };
  }
  const spec: UrlSource = { kind: "url", url, fetchUrl: url };
  if (range) spec.range = range;
  return { ok: true, spec };
}

/** The `src` string for a spec — the inverse of `parseSrc`, for rewriting. */
export function formatSrc(spec: SourceSpec): string {
  const r = spec.range;
  if (spec.kind === "file") return r ? `${spec.path}:${rangeText(r)}` : spec.path;
  if (spec.github) {
    if (!r) return spec.url;
    return r.start === r.end ? `${spec.url}#L${r.start}` : `${spec.url}#L${r.start}-L${r.end}`;
  }
  return r ? `${spec.url}:${rangeText(r)}` : spec.url;
}

function rangeText(r: LineRange): string {
  return r.start === r.end ? String(r.start) : `${r.start}-${r.end}`;
}

/** Whether a file source names a path outside the discovery root. */
export function isAbsoluteSource(spec: SourceSpec): boolean {
  return spec.kind === "file" && isAbsolute(spec.path);
}
