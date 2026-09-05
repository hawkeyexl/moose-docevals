---
status: "accepted"
date: 2026-09-05
decision-makers: [hawkeyexl]
---

# `cite` mints and refreshes citations, and refuses to mint what git has not seen

## Context and Problem Statement

ADR 01045 gives a page a way to pin the source lines a sentence depends on by sha256 and commit.
Nobody should type either by hand. A wrong hash reads as a guarantee and guarantees nothing, and
the never-true check exists because people will. The command that writes the record decides how
trustworthy the record is.

Two repairs recur. A range that *moved* is a mechanical rewrite of `src`. A range that *changed* is
a fact about the page someone has to act on before the hash is re-minted. A tool that did both on
one flag would paper over the second with the first.

## Decision Drivers

- Minting must be a command, so the hashing rule has one implementation and the commit recorded
  is one the repository can show.
- The commit recorded must be *true* of the bytes hashed, or the never-true check is noise.
- Moved is mechanical; changed is not. The command must not blur them.
- Both citation forms must be repaired in place, and a body edit must change nothing but the
  comment's own characters. This is the first place moose-docevals edits a page body.
- An author who wrote an inline comment without a hash should not have to leave the body to mint
  it.

## Considered Options

- Documentation only, publishing the rule and letting people script it.
- `cite add` only: mint and append a frontmatter entry.
- `cite add` and `cite refresh`, with `refresh` minting unminted citations, rewriting moved ranges,
  and re-minting changed ones only under a flag.
- `cite refresh` that re-mints everything it finds.

## Decision Outcome

The chosen option is **`cite add` and `cite refresh`**, with `refresh` doing the repair each
finding names and nothing more.

**Minting.** `mintCitation` hashes the range under the one rule, then records `git rev-parse HEAD`
as the commit, *after* confirming that `git show HEAD:./<path>` hashes to the same value. A file
git does not track, or one with uncommitted edits, is refused with a message naming the two ways
out: commit first, or `--no-commit`. A GitHub URL pinned to a sha carries its own commit; one
pinned to a branch records none. `--no-commit` is explicit: it says "no never-true check for this
one" in the record, by omission.

**`cite add <page> <src>`** mints one citation and appends a frontmatter entry. The id derives
from the source's name and range unless `--id` is given, and `--quote` sets the flag. It then
prints the reference comment to paste if the body does not already reference the id. `--inline` prints a fully minted
inline comment in the page's syntax and writes nothing. `--dry-run` reports and writes nothing.
A colliding id is a usage error naming `--id`.

**`cite refresh [globs]`** discovers pages, normalizes both forms through `resolvePage`, classifies
every citation with the grader's own classifier and readers, and edits in place:

| Status | Action |
|---|---|
| unminted | minted (hash and commit written into the entry or the comment) |
| moved | `src` rewritten to the new range; the commit stays |
| changed, never-true | kept, unless `--accept-changed`, then re-minted |
| current, missing, unreachable | untouched |

A mint the discipline above refuses is reported per citation and the run carries on. Frontmatter
edits go through the `yaml` Document API and touch only the named entry. Inline edits replace the
characters between `cite:` and the closing delimiter, from the end of the file backwards, so no
edit shifts a later span. Everything else in the file is byte-identical, and the test diffs whole
files to say so. Exit 0 in every case that is not operational: the gate is `run`.

**Why the commit stays on a move.** A moved rewrite changes where the bytes are, not what they
are. The recorded commit still names the version the hash was minted from. The never-true check
is move-tolerant for exactly this reason (ADR 01045).

### Consequences

- Good, because a hash in a page is one the tool computed from bytes git had committed.
  Otherwise it carries no commit, which says `--no-commit` was used.
- Good, because the finding, the refresh action, and the classifier are one code path. A status
  the grader reports is a status `refresh` acts on the same way.
- Good, because an author can write `<!-- cite: src=path:3-4 -->` and run one command.
- Bad, because `refresh` is the first body editor in the codebase. Accepted, with the
  only-the-comment invariant tested by whole-file diffs.
- Bad, because a repository with a dirty working tree cannot mint with a commit. Accepted: that
  is the point, and `--no-commit` is the documented way past it.
- Bad, and accepted: `--accept-changed` re-mints without reading the claim. It is a flag a person
  passes after reading the brief, not something a scheduled job passes.

### Confirmation

`test/unit/cite-command.test.ts` covers `add` and `refresh`. For `add` it covers mint, default id,
`--id`, `--quote`, `--inline`, `--dry-run`, the uncommitted and untracked refusals, `--no-commit`,
a URL source, and the id collision. For `refresh` it covers unminted in both forms, moved in both
forms, changed kept then re-minted, and never-true kept then re-minted. Current and missing
citations stay untouched, a refused mint is reported, and `--no-commit`, `--dry-run` and a page
with an error problem each get a case.
`frontmatter-cites.test.ts` and `citations-inline-edit.test.ts` pin the two writers, the second
by whole-file byte identity under CRLF and a BOM. `.github/workflows/ci.yml` walks the whole loop
in a scratch git repository. It covers unminted, `add`, `refresh`, moved, and changed with the
commit subject in the brief. It then covers kept without the flag, re-minted with it, and a
hand-corrupted hash failing at warning severity.
