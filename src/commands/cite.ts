/**
 * `moose-docevals cite add` and `cite refresh` — mint and repair citations
 * (ADR 01046), so nobody types a sha256 by hand.
 *
 * `add` mints one citation and appends it to the page's `cites` list (or,
 * with `--inline`, prints the comment to paste). `refresh` walks every
 * citation on the discovered pages, in both forms, and edits in place:
 * an unminted one is minted, a moved one gets its new range, and a changed
 * or never-true one is re-minted only under `--accept-changed`, because
 * "the source changed" is a fact about the page someone has to act on.
 */
import { writeFileSync } from "node:fs";
import { basename, extname, resolve, sep as pathSep } from "node:path";
import pc from "picocolors";
import { DocevalsError } from "../types.js";
import { loadConfig } from "../core/config.js";
import { discoverPages, readPage } from "../core/discover.js";
import { resolvePage, resolvePages } from "../core/resolve.js";
import { appendPageCites, updatePageCite, type CiteUpdates } from "../core/frontmatter-edit.js";
import { parseFormat, SUMMARY_FORMATS, type SummaryFormat } from "../reporters/format.js";
import { realExec } from "../graders/exec.js";
import type { ExecFn } from "../graders/types.js";
import { classifyCitation, type DriftStatus } from "../citations/classify.js";
import { formatSrc, parseSrc, type SourceSpec } from "../citations/hash.js";
import { rewriteInlineCitations, serializeInlineTokens, type InlineEdit } from "../citations/inline-edit.js";
import { mintCitation } from "../citations/mint.js";
import { makeReaders } from "../citations/readers.js";
import type { FetchLike } from "../citations/source.js";
import { NO_COMMIT, type Citation } from "../citations/types.js";

const runtimeFetch = (): FetchLike | undefined => globalThis.fetch;

/** How a page is written. Injected the way `exec` and `fetch` are. */
export type WriteFile = (absPath: string, content: string) => void;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- cite add

export interface CiteAddOptions {
  config?: string;
  cwd?: string;
  id?: string;
  quote?: boolean;
  /** Print a minted inline comment instead of writing frontmatter. */
  inline?: boolean;
  noCommit?: boolean;
  dryRun?: boolean;
  exec?: ExecFn;
  fetch?: FetchLike;
  /** Test seam for the page write; defaults to `writeFileSync`. */
  writeFile?: WriteFile;
}

export interface CiteEntry {
  id: string;
  src: string;
  sha256: string;
  commit?: string;
  quote?: boolean;
}

export interface CiteAddResult {
  file: string;
  entry: CiteEntry;
  /** Whether the page was written (false for --inline and --dry-run). */
  written: boolean;
  /** For --inline: the comment to paste, in the page's syntax. */
  inlineComment?: string;
  /** For the frontmatter form, when the body does not yet reference the id. */
  referenceHint?: string;
}

/**
 * A `src` as it should be recorded. On Windows a typed or tab-completed path
 * arrives with backslashes; committed that way it resolves only on Windows,
 * and the Linux leg of CI reports the source missing. A URL is left alone,
 * and so is a POSIX path, where a backslash is a legal filename character.
 */
export function portableSrc(src: string, separator: string = pathSep): string {
  if (separator !== "\\" || /^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return src;
  return src.replace(/\\/g, "/");
}

/** `scripts/install.sh:3-4` → `install-3-4`. */
function defaultId(spec: SourceSpec): string {
  const name = spec.kind === "file" ? basename(spec.path) : basename(new URL(spec.url).pathname);
  const stem = name.slice(0, name.length - extname(name).length) || name;
  const kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = kebab === "" || !/^[a-z0-9]/.test(kebab) ? `source-${kebab}`.replace(/-+$/, "") : kebab;
  const r = spec.range;
  return r ? `${base}-${r.start}${r.end === r.start ? "" : `-${r.end}`}` : base;
}

function commentFor(file: string, tokens: string): string {
  return extname(file).toLowerCase() === ".mdx" ? `{/* cite: ${tokens} */}` : `<!-- cite: ${tokens} -->`;
}

export async function runCiteAdd(
  pagePath: string,
  rawSrc: string,
  options: CiteAddOptions = {},
): Promise<CiteAddResult> {
  const src = portableSrc(rawSrc);
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? realExec;
  const fetch = options.fetch ?? runtimeFetch();

  const parsed = parseSrc(src);
  if (!parsed.ok) throw new DocevalsError(`src "${src}": ${parsed.error}`);
  const spec = parsed.spec;

  const absPage = resolve(cwd, pagePath);
  let page;
  try {
    page = readPage(absPage, cwd);
  } catch (e) {
    throw new DocevalsError(`cannot read ${pagePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (page.extractError) throw new DocevalsError(`${page.file}: ${page.extractError}`);
  const config = loadConfig(options.config, cwd);
  const plan = resolvePage(page, config);
  const problem = plan.problems.find((p) => p.level === "error");
  if (problem) throw new DocevalsError(`${page.file}:${problem.line ?? 1}: ${problem.message}`);

  const id = options.id ?? defaultId(spec);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new DocevalsError(`--id "${id}" must be kebab-case (lowercase letters, digits, hyphens)`);
  }
  // An inline comment carries an id only when the author asked for one, so
  // a derived id it will never write cannot collide with anything.
  const writesId = !options.inline || options.id !== undefined;
  if (writesId && plan.citations.entries.some((c) => c.id === id)) {
    throw new DocevalsError(
      `${page.file} already has a citation "${id}"; pass --id to name this one differently`,
    );
  }

  const minted = await mintCitation(spec, { root: cwd, exec, fetch, noCommit: options.noCommit });
  if (!minted.ok) throw new DocevalsError(`cannot cite ${src}: ${minted.reason}`);

  const entry: CiteEntry = { id, src, sha256: minted.sha256 };
  if (minted.commit !== undefined) entry.commit = minted.commit;
  // No commit was recorded, but the page has a default the new entry would
  // inherit. That commit was never checked against these bytes; say so.
  else if (plan.citations.defaultCommit !== undefined) entry.commit = NO_COMMIT;
  if (options.quote) entry.quote = true;

  if (options.inline) {
    const { id: derivedId, ...unnamed } = entry;
    const fields = options.id !== undefined ? { id: derivedId, ...unnamed } : unnamed;
    return {
      file: page.file,
      entry,
      written: false,
      inlineComment: commentFor(page.file, serializeInlineTokens(fields)),
    };
  }

  const updated = appendPageCites(page.content, page.file, [entry]);
  if (!options.dryRun) {
    // A bare Error here would escape the CLI's DocevalsError funnel as a
    // stack trace and exit 1, which reads as "findings". It is operational.
    try {
      (options.writeFile ?? writeFileSync)(absPage, updated);
    } catch (e) {
      throw new DocevalsError(`could not write ${page.file}: ${errorText(e)}`);
    }
  }
  const referenced = plan.citations.orphans.some((o) => o.id === id);
  const result: CiteAddResult = { file: page.file, entry, written: !options.dryRun };
  if (!referenced) result.referenceHint = commentFor(page.file, id);
  return result;
}

export function renderCiteAdd(result: CiteAddResult, format: SummaryFormat): string {
  parseFormat(format, SUMMARY_FORMATS, "format");
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines: string[] = [];
  const at = result.entry.commit !== undefined ? ` @ ${result.entry.commit.slice(0, 7)}` : "";
  if (result.inlineComment !== undefined) {
    lines.push(`Minted ${result.entry.src}${at}. Put this on the line above the sentence it supports:`);
    lines.push(`  ${result.inlineComment}`);
    return lines.join("\n");
  }
  const verb = result.written ? "Added" : "Would add";
  lines.push(`${verb} ${pc.bold(result.entry.id)} → ${result.entry.src}${at} to ${result.file}`);
  if (result.referenceHint !== undefined) {
    lines.push(`No comment in ${result.file} references it yet. Put this on the line above the sentence it supports:`);
    lines.push(`  ${result.referenceHint}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ cite refresh

export interface CiteRefreshOptions {
  config?: string;
  cwd?: string;
  /** Re-mint changed and never-true citations. */
  acceptChanged?: boolean;
  noCommit?: boolean;
  dryRun?: boolean;
  exec?: ExecFn;
  fetch?: FetchLike;
  /** Test seam for the page write; defaults to `writeFileSync`. */
  writeFile?: WriteFile;
}

export type RefreshStatus = DriftStatus | "never-true";
export type RefreshAction = "minted" | "rewritten" | "re-minted" | "kept" | "unchanged";

export interface CiteRefreshEntry {
  file: string;
  id: string;
  src: string;
  origin: Citation["origin"];
  status: RefreshStatus;
  action: RefreshAction;
  /** For a rewritten range: the new `src`. */
  newSrc?: string;
  detail?: string;
}

export interface CiteRefreshReport {
  entries: CiteRefreshEntry[];
  filesWritten: string[];
  /**
   * Pages `refresh` could not finish: skipped for an error-level resolution
   * problem, or classified and then not written.
   */
  problems: { file: string; message: string }[];
  dryRun: boolean;
  /**
   * 0, or 2 when a page could not be written. Drift is never an exit code
   * here (the gate is `run`), but a repair the command reported and did not
   * land is operational, and exit 0 would say it had.
   */
  exitCode: 0 | 2;
}

export async function runCiteRefresh(
  globs: string[],
  options: CiteRefreshOptions = {},
): Promise<CiteRefreshReport> {
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? realExec;
  const fetch = options.fetch ?? runtimeFetch();
  const config = loadConfig(options.config, cwd);
  const pages = discoverPages(config, globs, cwd);
  const plans = resolvePages(pages, config);

  const report: CiteRefreshReport = {
    entries: [],
    filesWritten: [],
    problems: [],
    dryRun: options.dryRun === true,
    exitCode: 0,
  };
  const writeFile = options.writeFile ?? writeFileSync;
  const mint = (spec: SourceSpec) =>
    mintCitation(spec, { root: cwd, exec, fetch, noCommit: options.noCommit });

  for (const plan of plans) {
    const file = plan.page.file;
    const error = plan.problems.find((p) => p.level === "error");
    if (error) {
      report.problems.push({ file, message: `line ${error.line ?? 1}: ${error.message}` });
      continue;
    }
    if (plan.citations.entries.length === 0) continue;

    const { readers } = makeReaders({ root: cwd, exec, fetch, network: true });
    const inlineEdits: InlineEdit[] = [];
    const frontmatterEdits: { id: string; updates: CiteUpdates }[] = [];

    // Entries whose action depends on this page being written.
    const staged: CiteRefreshEntry[] = [];

    const stage = (c: Citation, updates: CiteUpdates, entry: CiteRefreshEntry): void => {
      staged.push(entry);
      if (c.origin === "inline" && c.comment) {
        // Only the tokens that change. The comment is never rebuilt, so the
        // author's token order and anything else they wrote survive.
        inlineEdits.push({ span: c.comment.span, updates });
      } else {
        frontmatterEdits.push({ id: c.id, updates });
      }
    };

    for (const c of plan.citations.entries) {
      const verdict = await classifyCitation(c, readers);
      const status: RefreshStatus = verdict.neverTrue ? "never-true" : verdict.status;
      const entry: CiteRefreshEntry = { file, id: c.id, src: c.src, origin: c.origin, status, action: "kept" };
      report.entries.push(entry);

      if (status === "current") {
        entry.action = "unchanged";
        continue;
      }
      if (status === "unminted" || ((status === "changed" || status === "never-true") && options.acceptChanged)) {
        const minted = await mint(c.spec);
        if (!minted.ok) {
          entry.detail = minted.reason;
          continue;
        }
        const updates: CiteUpdates = { sha256: minted.sha256 };
        if (minted.commit !== undefined) updates.commit = minted.commit;
        // A mint that records no commit (--no-commit, a branch-pinned URL)
        // must not leave the citation attached to one. Beside the new hash,
        // the next change would be checked against a commit the new bytes
        // never existed at, and reported as never-true instead of changed.
        else if (c.commitSource === "page") {
          // Inherited from `cite-commit`: nothing at the entry to remove, so
          // the entry opts out of the default.
          updates.commit = NO_COMMIT;
        } else if (c.commitSource === "entry" && c.commit !== undefined && status !== "unminted") {
          // Its own commit, now stale. Removing it would fall back to the
          // page default where there is one, which is no better.
          updates.commit = plan.citations.defaultCommit !== undefined ? NO_COMMIT : null;
        }
        stage(c, updates, entry);
        entry.action = status === "unminted" ? "minted" : "re-minted";
        continue;
      }
      if (status === "moved" && verdict.movedTo) {
        const newSrc = formatSrc({ ...c.spec, range: verdict.movedTo });
        stage(c, { src: newSrc }, entry);
        entry.action = "rewritten";
        entry.newSrc = newSrc;
        if ((verdict.movedMatches ?? 1) > 1) {
          entry.detail = `${String(verdict.movedMatches)} windows matched; the first was taken`;
        }
        continue;
      }
      // The classifier's own detail first (why the moved search was skipped,
      // say), then the hint. Assigning the hint over it lost the reason.
      if (verdict.detail !== undefined) entry.detail = verdict.detail;
      if (status === "changed" || status === "never-true") {
        const hint = "pass --accept-changed to re-mint";
        entry.detail = entry.detail !== undefined ? `${entry.detail}; ${hint}` : hint;
      }
    }

    if (inlineEdits.length === 0 && frontmatterEdits.length === 0) continue;
    // One page failing must not lose the report or the pages after it.
    // Record it, take back the actions that did not land, and carry on. That
    // holds for the edit as much as the write: a page whose frontmatter
    // cannot be edited in place (TOML, say) throws before anything is written.
    const failed = (reason: string): void => {
      report.problems.push({ file, message: reason });
      report.exitCode = 2;
      for (const entry of staged) {
        entry.action = "kept";
        entry.detail = reason;
        delete entry.newSrc;
      }
    };

    let content: string;
    try {
      // Inline spans are offsets into the original content, so they go
      // first; the frontmatter edit then re-serializes only the block above
      // the body.
      content = rewriteInlineCitations(plan.page.content, inlineEdits);
      for (const { id, updates } of frontmatterEdits) {
        content = updatePageCite(content, file, id, updates);
      }
    } catch (e) {
      failed(`could not edit: ${errorText(e)}`);
      continue;
    }
    if (!options.dryRun) {
      try {
        writeFile(plan.page.absPath, content);
        report.filesWritten.push(file);
      } catch (e) {
        failed(`could not write: ${errorText(e)}`);
      }
    }
  }
  return report;
}

const ACTION_COLOR: Record<RefreshAction, (s: string) => string> = {
  minted: pc.green,
  rewritten: pc.green,
  "re-minted": pc.green,
  kept: pc.yellow,
  unchanged: pc.dim,
};

export function renderCiteRefresh(report: CiteRefreshReport, format: SummaryFormat): string {
  parseFormat(format, SUMMARY_FORMATS, "format");
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines: string[] = [];
  for (const e of report.entries) {
    const arrow = e.newSrc !== undefined ? ` → ${e.newSrc}` : "";
    const detail = e.detail !== undefined ? pc.dim(`  (${e.detail})`) : "";
    lines.push(
      `${ACTION_COLOR[e.action](e.action.padEnd(10))} ${e.file}  ${e.id}: ${e.src}${arrow}  [${e.status}]${detail}`,
    );
  }
  for (const p of report.problems) {
    lines.push(`${pc.red("skipped   ")} ${p.file}  ${p.message}`);
  }
  if (report.entries.length === 0 && report.problems.length === 0) {
    lines.push("No citations found.");
  }
  if (report.dryRun) {
    lines.push(pc.dim("Dry run: nothing was written."));
  } else if (report.filesWritten.length > 0) {
    lines.push(`Wrote ${report.filesWritten.length} file(s).`);
  }
  return lines.join("\n");
}
