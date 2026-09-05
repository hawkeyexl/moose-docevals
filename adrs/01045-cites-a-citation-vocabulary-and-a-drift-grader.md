---
status: "accepted"
date: 2026-09-05
decision-makers: [hawkeyexl]
---

# `cites`: a citation vocabulary and a drift grader, ahead of docmeta

## Context and Problem Statement

A documentation page that quotes or paraphrases source code has no way to say *which lines* it
depends on. Nothing tells its author when those lines change. `docmeta:stewardship` carries
`source-of-truth`, a page-to-file pointer whose description promises "the anchor a drift check
compares the page against". No tool implements that check, and page-to-file is too coarse to say
which sentence went stale. The alternative today is an `ai` eval. That is three model calls to compare a sentence to a
file, on every run, for a question code answers with one hash.

Gleb Lukicov's "Your documentation is a build artifact" (2026-08-28) records three facts on every
generated snippet. They are the source range, the sha256 of those bytes, and the commit. A zero-token check
then classifies each as current, moved, or changed, and only a change spends a person's or an
agent's attention. That split is this repo's grader ladder, stated by someone else. This repo
already applies the hash-as-lockfile idea to one field, `generated-assertion-hash`.

The design was settled with two rulings from the person who owns the vocabulary. A sentence is
never repeated in frontmatter. An inline citation must work with no frontmatter at all.

## Decision Drivers

- The cheapest expressible check for "does the page still match the code" should be code, not a
  judge. "Prefer a deterministic grader" is only followable if one exists (ADR 01029).
- A finding must name the *sentence*, not just the page. Anything coarser is a page-level
  freshness date with extra steps.
- The frontmatter must not carry the sentence. Repeating prose in metadata is the drift problem
  restated one level up.
- An author should be able to cite from the body alone, so the common case is one comment above
  one sentence.
- The page vocabulary is docmeta's (ADR 01009). This adds to it before docmeta has a proposal,
  which CLAUDE.md says must be recorded rather than done quietly.
- A hash typed by hand is worse than no hash: it reads as a guarantee and guarantees nothing.

## Considered Options

- An `ai` eval per cited sentence.
- `cites` in frontmatter only, with a `claim` field carrying the sentence verbatim.
- `cites` in frontmatter with a body *marker* naming the entry, plus an inline form that carries
  the whole entry as `key=value` tokens in the same comment.
- A separate `schemas/citations-1.0.0.json` beside the frontmatter schema, versus a new
  `frontmatter-1.2.0.json`.

## Decision Outcome

The chosen option is **`cites` in frontmatter with a body comment as the anchor, plus the inline
form**, published as **`schemas/frontmatter-1.2.0.json`**, with **`tool:citations`** as the grader.

**The vocabulary.** Two page keys and a reserved prefix, mirroring `evals`: `cites`, a non-empty
list of closed entries (`id`, `src`, optional `sha256`, `commit`, `quote`), and `cite-commit`, a
page-level default commit. A `cite-*` key that is not `cite-commit` is an error, the loud-typo
property `eval-` already has. `src` is `path`, `path:L`, `path:L1-L2` (relative to the directory
moose-docevals runs in, or absolute), a GitHub blob URL with `#L1-L2`, or another https URL with a
`:L1-L2` suffix. `sha256` may be absent: that is an *unminted* citation, which `cite refresh`
fills and `run` reports, never a pass.

**The body comment.** `<!-- cite: BODY -->` in Markdown, the same tokens in a JSX comment in MDX.
A body of one kebab token is a *reference* to a frontmatter entry. A body of `key=value` tokens
(with `quote` as a bare flag) is an *inline citation*: the entry itself, with exactly the
frontmatter entry's field names. `resolvePage` builds the object from the tokens, validates it
against the same `$defs/citationEntry` the `cites` list uses, and appends it to one list beside
the frontmatter entries. Nothing downstream knows which form a citation came from except
`cite refresh`, which has to know where to write. The sentence beside the comment, the *claim*, is
what findings quote back. Comments inside fenced code blocks and inline code spans are ignored, so
a page that documents the syntax declares nothing.

**The hashing rule** is stated once, in `src/citations/hash.ts`. Read as UTF-8 and strip a
byte-order mark. Normalize line endings to LF. Join lines L1..L2 inclusive (1-based) with LF, no
trailing newline, trailing whitespace preserved. No range means every line. The same rule hashes a fetched
URL and a quoted code block, so two machines mint the same hash for the same bytes.

**The grader.** `tool:citations` re-hashes each citation's range and reports:

| Status | Rule | Finding |
|---|---|---|
| current | the range hashes to the record | none |
| moved | a same-length window elsewhere in the file does | `citations/moved`, info, with the new `src` |
| changed | neither | `citations/changed`, eval severity, with the claim, the commit subjects since, and the `git diff` command |
| missing | the source cannot be read | `citations/missing`, eval severity |
| never-true | with `commit`: the bytes existed nowhere in the file at that commit | `citations/never-true`, **diagnostic** |
| unminted | no `sha256` | `citations/unminted`, eval severity |

Plus `citations/unreachable` (diagnostic: a URL that cannot be fetched), `citations/network-off`
(info, under `options.network: false`), `citations/commit-unresolved` (info: a shallow clone),
`citations/no-git` (info, once per page), `citations/reference-orphan` (warning), and the `quote`
pair, `citations/quote-drift` and `citations/quote-missing` (eval severity). Never-true is
diagnostic because a citation that was never right says nothing about drift. At `warning` it
would otherwise report and pass, which is the shape ADR 01022 forbids. It is move-tolerant: the
question is whether the bytes existed *anywhere* at the commit, because `cite refresh` rewrites a
moved range and leaves the commit alone.

**Why 1.2.0 and not a separate schema.** A second schema file would keep `frontmatter-1.1.0.json`
undiverged from `docmeta:evals:1.0.0-proposal.2`. The owner chose one file for consumers. The
divergence is therefore deliberate and recorded here. 1.2.0 adds a vocabulary docmeta has not
proposed yet, and the docmeta proposal is the follow-up. 1.0.0 and 1.1.0 stay shipped and
byte-frozen (ADR 01035).

**Why `src` may be absolute or a URL.** A citation reveals only "same or different", never
content. Reading a path the page names is the low-risk end of the hazard `tool:file-exists`
refuses, content naming a path on the eval's machine. Network goes through an
injected `fetch`, so the suite stays offline and an air-gapped job can set `network: false`.

**Placement.** The starter config declares `cited-sources-current` at `severity: warning` in the
default suite, so a pull-request job reports and a scheduled sweep can escalate. A page with no
citations passes silently. A page that declares citations no `tool:citations` eval checks gets a
warning problem. A record nobody checks is decoration that looks like a guarantee.
`applySinceScope` already keeps `tool:` evals on unchanged pages (ADR 01040), so a scoped run still
catches a source that moved under a page nobody touched.

### Consequences

- Good, because "does the page still match the code" is now a file read and a sha256 on every
  run. The finding names the sentence.
- Good, because the inline form makes the common case one comment above one sentence. The
  frontmatter form still serves a range cited from several sentences, and tooling that reads
  metadata without scanning bodies.
- Good, because a hand-typed hash is caught, not trusted.
- Bad, because the frontmatter schema now carries a vocabulary docmeta has not registered.
  Accepted, because the field names are chosen to be proposed as they stand, and the proposal is
  owed.
- Bad, because two comment syntaxes exist. Accepted, because MDX forbids HTML comments, and the tokens
  are identical.
- Bad, because the grader can touch the network. Accepted, through the injected `fetch`, the
  per-eval switch, and the diagnostic on failure.
- Neutral, because `quote` is the one piece that can be removed without touching anything else.

### Confirmation

`test/unit/citations-hash.test.ts` pins the rule and the `src` grammar. `citations-comments.test.ts`
pins both syntaxes, reference-versus-inline detection, the claim, and the two places a comment is
ignored. `citations-resolve.test.ts` pins normalization into one list and every page problem.
`citations-classify.test.ts` pins every status in memory, including move-tolerant never-true.
`citations-grader.test.ts` drives the real engine over a scaffold for every finding. `no-verdict.test.ts`
enumerates the two diagnostic shapes (ADR 01023). `schema.test.ts` carries the 1.2.0 ladder. The
fixture corpus cites `test/fixtures/cited/greeting.sh` in both forms and both outcomes, asserted by
`test/integration/deterministic.test.ts` and `.github/workflows/ci.yml`; the docs corpus cites it
too, under `verify-docs`.
