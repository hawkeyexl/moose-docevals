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
import { basename, extname, resolve } from "node:path";
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
import type { Citation } from "../citations/types.js";

const runtimeFetch = (): FetchLike | undefined => globalThis.fetch;

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
  src: string,
  options: CiteAddOptions = {},
): Promise<CiteAddResult> {
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
  if (plan.citations.entries.some((c) => c.id === id)) {
    throw new DocevalsError(
      `${page.file} already has a citation "${id}"; pass --id to name this one differently`,
    );
  }

  const minted = await mintCitation(spec, { root: cwd, exec, fetch, noCommit: options.noCommit });
  if (!minted.ok) throw new DocevalsError(`cannot cite ${src}: ${minted.reason}`);

  const entry: CiteEntry = { id, src, sha256: minted.sha256 };
  if (minted.commit !== undefined) entry.commit = minted.commit;
  if (options.quote) entry.quote = true;

  if (options.inline) {
    const { id: _omitted, ...fields } = entry;
    void _omitted;
    return {
      file: page.file,
      entry,
      written: false,
      inlineComment: commentFor(page.file, serializeInlineTokens(fields)),
    };
  }

  const updated = appendPageCites(page.content, page.file, [entry]);
  if (!options.dryRun) writeFileSync(absPage, updated);
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
  /** Pages skipped for an error-level resolution problem. */
  problems: { file: string; message: string }[];
  dryRun: boolean;
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
  };
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

    const stage = (c: Citation, updates: CiteUpdates): void => {
      if (c.origin === "inline" && c.comment) {
        const fields = {
          id: c.id.startsWith("inline-") ? undefined : c.id,
          src: updates.src ?? c.src,
          sha256: updates.sha256 ?? c.sha256,
          commit: updates.commit ?? c.commit,
          quote: c.quote,
        };
        inlineEdits.push({ span: c.comment.span, entry: fields });
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
        stage(c, updates);
        entry.action = status === "unminted" ? "minted" : "re-minted";
        continue;
      }
      if (status === "moved" && verdict.movedTo) {
        const newSrc = formatSrc({ ...c.spec, range: verdict.movedTo });
        stage(c, { src: newSrc });
        entry.action = "rewritten";
        entry.newSrc = newSrc;
        if ((verdict.movedMatches ?? 1) > 1) {
          entry.detail = `${String(verdict.movedMatches)} windows matched; the first was taken`;
        }
        continue;
      }
      if (verdict.detail !== undefined) entry.detail = verdict.detail;
      if (status === "changed" || status === "never-true") {
        entry.detail = "pass --accept-changed to re-mint";
      }
    }

    if (inlineEdits.length === 0 && frontmatterEdits.length === 0) continue;
    // Inline spans are offsets into the original content, so they go first;
    // the frontmatter edit then re-serializes only the block above the body.
    let content = rewriteInlineCitations(plan.page.content, inlineEdits);
    for (const { id, updates } of frontmatterEdits) {
      content = updatePageCite(content, file, id, updates);
    }
    if (!options.dryRun) {
      writeFileSync(plan.page.absPath, content);
      report.filesWritten.push(file);
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
