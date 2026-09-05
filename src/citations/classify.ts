/**
 * The drift classifier (ADR 01045). Given a citation and readers for its
 * source, says whether the cited lines are still there:
 *
 *   current   the range hashes to the recorded value
 *   moved     it does not, but a same-length window elsewhere in the file does
 *   changed   neither — the lines were edited, or the file got shorter
 *   missing   the source cannot be read at all
 *
 * plus the states about the *citation* rather than the source: `unminted`
 * (no hash yet), and, when a commit is recorded, `neverTrue` (the range at
 * that commit does not hash to the record either, so the citation was typed
 * by hand or minted against uncommitted edits) and `commitUnresolved` (the
 * repository cannot show that commit — a shallow clone, usually).
 *
 * Pure over injected readers, so it runs in memory under test and the grader
 * and `cite refresh` share one verdict.
 */
import { hashLines, normalizeLines, sliceRange, type LineRange, type SourceSpec } from "./hash.js";
import type { SourceRead } from "./source.js";
import type { Citation } from "./types.js";

export type DriftStatus =
  | "current"
  | "moved"
  | "changed"
  | "missing"
  | "unreachable"
  | "network-off"
  | "unminted";

export interface ClassifyReaders {
  readSource: (spec: SourceSpec) => Promise<SourceRead>;
  /** Absent when there is no way to read history (no git, plain URL). */
  readAtCommit?: (spec: SourceSpec, commit: string) => Promise<SourceRead>;
  /** Subjects of commits touching the source since `commit`; absent when unknown. */
  subjectsSince?: (spec: SourceSpec, commit: string) => Promise<string[] | undefined>;
}

export interface Classification {
  status: DriftStatus;
  /** The source's normalized lines, when it could be read. */
  sourceLines?: string[];
  /** For `moved`: where the lines are now, and how many windows matched. */
  movedTo?: LineRange;
  movedMatches?: number;
  /** With a commit, on a non-current citation: the record was never right. */
  neverTrue?: boolean;
  /** With a commit the repository could not show: why. */
  commitUnresolved?: string;
  /** With a commit, on a changed citation: what touched the source since. */
  subjects?: string[];
  /** Human-readable detail for the message. */
  detail?: string;
}

/** Above this many characters the moved search is skipped; the file is reported as changed. */
export const MOVED_SEARCH_MAX_CHARS = 2_000_000;

export async function classifyCitation(
  c: Citation,
  readers: ClassifyReaders,
): Promise<Classification> {
  if (c.sha256 === undefined) return { status: "unminted" };

  const read = await readers.readSource(c.spec);
  if (!read.ok) return { status: read.status, detail: read.detail };

  const lines = normalizeLines(read.text);
  const range = c.spec.range;
  const selected = sliceRange(lines, range);
  if (selected !== undefined && hashLines(selected) === c.sha256) {
    return { status: "current", sourceLines: lines };
  }

  let result: Classification;
  if (range === undefined) {
    // A whole-file citation has nowhere to move to.
    result = { status: "changed", sourceLines: lines };
  } else if (read.text.length > MOVED_SEARCH_MAX_CHARS) {
    result = {
      status: "changed",
      sourceLines: lines,
      detail: `source is too large (${read.text.length} chars) to search for moved lines`,
    };
  } else {
    const matches = findWindows(lines, range.end - range.start + 1, c.sha256, range.start);
    result =
      matches.length > 0
        ? {
            status: "moved",
            sourceLines: lines,
            movedTo: { start: matches[0]!, end: matches[0]! + (range.end - range.start) },
            movedMatches: matches.length,
          }
        : { status: "changed", sourceLines: lines };
  }

  if (c.commit !== undefined && readers.readAtCommit !== undefined) {
    const then = await readers.readAtCommit(c.spec, c.commit);
    if (!then.ok) {
      result.commitUnresolved = `${c.commit}: ${then.detail}`;
    } else if (!existedAt(normalizeLines(then.text), range, c.sha256)) {
      result.neverTrue = true;
    }
  }
  if (result.status === "changed" && c.commit !== undefined && readers.subjectsSince !== undefined) {
    const subjects = await readers.subjectsSince(c.spec, c.commit);
    if (subjects !== undefined) result.subjects = subjects;
  }
  return result;
}

/**
 * Whether the cited bytes existed *anywhere* in the file at the commit. The
 * range is not required to match: `cite refresh` rewrites a moved range and
 * leaves the commit alone, so the recorded range at the recorded commit is
 * the wrong question once the lines have moved. Never-true means the bytes
 * were never there at all.
 */
function existedAt(linesThen: string[], range: LineRange | undefined, hash: string): boolean {
  const at = sliceRange(linesThen, range);
  if (at !== undefined && hashLines(at) === hash) return true;
  if (range === undefined) return false;
  return findWindows(linesThen, range.end - range.start + 1, hash, 0).length > 0;
}

/** 1-based start lines of every `length`-line window hashing to `hash`, except `skipStart`. */
function findWindows(lines: string[], length: number, hash: string, skipStart: number): number[] {
  const found: number[] = [];
  for (let start = 1; start + length - 1 <= lines.length; start++) {
    if (start === skipStart) continue;
    if (hashLines(lines.slice(start - 1, start - 1 + length)) === hash) found.push(start);
  }
  return found;
}
