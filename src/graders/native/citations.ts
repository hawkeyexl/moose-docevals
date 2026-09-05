/**
 * Native drift check over a page's citations (ADR 01045).
 *
 * A citation pins a range of a source file by hash. This grader re-hashes
 * the range and reports what it finds: the lines moved (info, with the new
 * `src`), changed or vanished (the eval's severity, with the sentence that
 * depended on them), or were never what the citation claimed (diagnostic —
 * a hand-typed hash tells you nothing about drift, so it fails at any
 * severity). It costs a file read and a sha256 per citation: no model, and
 * no network unless a citation points at a URL.
 *
 * The classifier does the deciding; this file turns its verdicts into
 * findings and adds the page-side checks — an orphaned reference comment,
 * and the `quote` comparison of a fenced block against the cited lines.
 */
import type { Finding } from "../../types.js";
import type { Grader } from "./../types.js";
import {
  firstError,
  knownKeys,
  optionalBoolean,
  type OptionCheck,
  type Options,
} from "../options.js";
import { classifyCitation } from "../../citations/classify.js";
import { fencedBlockAfter } from "../../citations/comments.js";
import { formatSrc, hashLines, normalizeLines, sliceRange } from "../../citations/hash.js";
import { makeReaders } from "../../citations/readers.js";
import type { Citation } from "../../citations/types.js";

interface CitationsOptions {
  network?: boolean;
}

const CLAIM_MAX = 100;
const SUBJECTS_MAX = 5;

function claimText(c: Citation): string {
  const claim = c.anchors[0]?.claim ?? "";
  if (claim === "") return "";
  const short = claim.length > CLAIM_MAX ? `${claim.slice(0, CLAIM_MAX - 1)}…` : claim;
  return ` Claim: "${short}"`;
}

export const citationsGrader: Grader = {
  kind: "tool:citations",
  validateOptions(options: Options): OptionCheck {
    return firstError(knownKeys(options, ["network"]), optionalBoolean(options, "network"));
  },
  mode: "per-file",
  async grade(ctx) {
    const findings: Finding[] = [];
    for (const { plan, eval: ev } of ctx.targets) {
      const { entries, orphans } = plan.citations;
      if (entries.length === 0 && orphans.length === 0) continue;

      const file = plan.page.file;
      const network = (ev.options as CitationsOptions).network ?? true;
      const refresh = `moose-docevals cite refresh ${file}`;
      const push = (f: Omit<Finding, "evalName" | "file">) =>
        findings.push({ evalName: ev.name, file, ...f });

      // Git is consulted lazily and, once found missing, never again on this
      // page: one finding says so rather than one per citation.
      const { readers, gitMissing } = makeReaders({
        root: ctx.root,
        exec: ctx.exec,
        fetch: ctx.fetch,
        network,
      });

      // Where a `quote` block may be looked for: up to the next comment.
      const pageLines = plan.page.content.split(/\r?\n/);
      const commentLines = [
        ...entries.flatMap((e) => e.anchors.map((a) => a.line)),
        ...orphans.map((o) => o.line),
      ].sort((a, b) => a - b);
      const boundAfter = (line: number): number =>
        (commentLines.find((l) => l > line) ?? pageLines.length + 1) - 1;

      for (const c of entries) {
        const line = c.anchors[0]?.line ?? c.line;
        const verdict = await classifyCitation(c, readers);

        if (verdict.neverTrue) {
          push({
            ruleId: "citations/never-true",
            message:
              `${c.id}: ${c.src} does not hash to the recorded sha256 at ${c.commit ?? "?"} either — ` +
              `the citation was never minted from that commit (a hand-typed hash, or uncommitted ` +
              `edits). Check the claim, then re-mint with \`${refresh} --accept-changed\`.${claimText(c)}`,
            severity: ev.severity,
            diagnostic: true,
            line,
          });
          continue;
        }

        switch (verdict.status) {
          case "current":
            break;
          case "unminted":
            push({
              ruleId: "citations/unminted",
              message: `${c.id}: ${c.src} has no sha256 yet. Run \`${refresh}\` to mint it.${claimText(c)}`,
              severity: ev.severity,
              line,
            });
            break;
          case "missing":
            push({
              ruleId: "citations/missing",
              message: `${c.id}: ${verdict.detail ?? `${c.src} not found`}.${claimText(c)}`,
              severity: ev.severity,
              line,
            });
            break;
          case "unreachable":
            push({
              ruleId: "citations/unreachable",
              message: `${c.id}: could not read ${c.src} (${verdict.detail ?? "unknown error"})`,
              severity: ev.severity,
              diagnostic: true,
              line,
            });
            break;
          case "network-off":
            push({
              ruleId: "citations/network-off",
              message: `${c.id}: ${c.src} not checked — options.network is false`,
              severity: "info",
              line,
            });
            break;
          case "moved": {
            const to = { ...c.spec, range: verdict.movedTo };
            const n = verdict.movedMatches ?? 1;
            push({
              ruleId: "citations/moved",
              message:
                `${c.id}: ${c.src} is now ${formatSrc(to)} (unchanged content)` +
                (n > 1 ? `; ${n} windows match, so widen the range to disambiguate` : "") +
                `. Run \`${refresh}\` to update it.`,
              severity: "info",
              line,
            });
            break;
          }
          case "changed": {
            const subjects = verdict.subjects ?? [];
            const listed = subjects
              .slice(0, SUBJECTS_MAX)
              .map((s) => `"${s}"`)
              .join("; ");
            const more = subjects.length > SUBJECTS_MAX ? `; +${subjects.length - SUBJECTS_MAX} more` : "";
            const touched =
              subjects.length > 0
                ? ` ${subjects.length} commit(s) touched it: ${listed}${more}.`
                : "";
            const diff =
              c.commit !== undefined && c.spec.kind === "file"
                ? ` Compare with: git diff ${c.commit} HEAD -- ${c.spec.path}`
                : "";
            const detail = verdict.detail ? ` (${verdict.detail})` : "";
            push({
              ruleId: "citations/changed",
              message:
                `${c.id}: ${c.src} changed${c.commit !== undefined ? ` since ${c.commit}` : ""}${detail}.` +
                `${touched}${claimText(c)}${diff}`,
              severity: ev.severity,
              line,
            });
            break;
          }
        }

        if (verdict.commitUnresolved !== undefined && !gitMissing()) {
          push({
            ruleId: "citations/commit-unresolved",
            message:
              `${c.id}: could not read ${c.src} at ${verdict.commitUnresolved}; the never-true ` +
              `check was skipped. In CI this is usually a shallow clone (fetch-depth: 1).`,
            severity: "info",
            line,
          });
        }

        // The page's copy of the lines, compared against the source as it is
        // now. Skipped when the source itself changed or could not be read:
        // that finding already covers it.
        if (c.quote && (verdict.status === "current" || verdict.status === "moved")) {
          const expected = sliceRange(verdict.sourceLines ?? [], verdict.movedTo ?? c.spec.range);
          const anchors = c.anchors.length > 0 ? c.anchors : [{ line: c.line }];
          for (const anchor of anchors) {
            const block = fencedBlockAfter(pageLines, anchor.line, boundAfter(anchor.line));
            if (block === undefined) {
              push({
                ruleId: "citations/quote-missing",
                message: `${c.id}: quote is true, but no fenced code block follows the citation comment`,
                severity: ev.severity,
                line: anchor.line,
              });
              continue;
            }
            if (expected !== undefined && hashLines(normalizeLines(block.text)) !== hashLines(expected)) {
              push({
                ruleId: "citations/quote-drift",
                message:
                  `${c.id}: the code block after the citation comment differs from ${c.src} — ` +
                  `the copy in the page was edited, or the source was and the page not re-quoted`,
                severity: ev.severity,
                line: block.line,
              });
            }
          }
        }
      }

      for (const o of orphans) {
        push({
          ruleId: "citations/reference-orphan",
          message: `cite: ${o.id} names no citation on this page`,
          severity: "warning",
          line: o.line,
        });
      }

      if (gitMissing()) {
        push({
          ruleId: "citations/no-git",
          message:
            "git is not available, so the commit-based checks (never-true, commit subjects) " +
            "were skipped for this page",
          severity: "info",
          line: 1,
        });
      }
    }
    return findings;
  },
};
