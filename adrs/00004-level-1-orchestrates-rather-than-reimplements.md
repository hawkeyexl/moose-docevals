---
status: "accepted"
date: 2026-08-31
decision-makers: [hawkeyexl]
---

# Deterministic checks orchestrate existing tools rather than reimplementing them

**Backfill.** This records a decision made before the ADR rule existed; until now it lived only as a bullet in [CLAUDE.md](../CLAUDE.md#design-decisions). The date is when the record was written, not when the decision was taken.

## Context and Problem Statement

The bottom of the grader hierarchy is deterministic checking: style, structure, metadata validity, whether documented commands actually run. Mature tools already do all of this — markdownlint, Vale, doc-structure-lint, docmeta, Doc Detective — and every one of them is better at its job than a reimplementation inside this repo would be.

So: does moose-docevals *implement* deterministic checks, or *invoke* the tools that already do?

## Decision Drivers

- **Rule sets are the product.** Vale's value is its style rules and the years of tuning in them; markdownlint's is its rule catalogue. Reimplementing the runner without the rules delivers nothing.
- Users have existing configuration — `.vale.ini`, `.markdownlint.json` — that must keep working, because abandoning it is a reason not to adopt.
- Every reimplementation is a permanent maintenance obligation that falls behind upstream.
- The tool's actual contribution is the *eval* concept: naming a check, giving it a severity, putting it in a suite, and gating on it. That is orchestration.

## Considered Options

- **Wrap existing tools**, parsing their output into a common `Finding` shape.
- **Reimplement checks natively**, for control over output and to avoid dependencies.
- Wrap tools, but reimplement any whose output is awkward to parse.

## Decision Outcome

Chosen option: **wrap existing tools, and write native graders only where nothing else covers the gap.**

Each adapter in [src/graders/tools/](../src/graders/tools) invokes a real tool and normalizes its output into `Finding[]`. The line is drawn empirically rather than by preference: the native graders in [src/graders/native/](../src/graders/native) are `freshness`, `reading-level`, and `differentiation` — three checks for which no established tool exists. Reading level is ~60 vendored lines of Flesch-Kincaid rather than a dependency, and its English-only limitation is documented rather than hidden.

Two constraints follow from wrapping, and both have bitten:

- **Output parsing is a contract with someone else's tool.** A tool that changes its format, or emits something unreadable, must produce a *finding* rather than a pass — ADR 01020, later sharpened by ADR 01022 into "a grader that reached no verdict fails the eval."
- **Inherited defaults are a supply chain for meaning.** `tool:docmeta` must pass an explicit `schemas` option, because inheriting docmeta's own `DEFAULT_SCHEMAS` would silently change what a bare eval *means* on a dependency bump — measured on the 1.3 → 4.12 upgrade, where all 13 fixture pages began failing `google:okf:0.1` for a missing `type` (ADR 01013).

### Consequences

- Good, because users keep their existing tool configuration and their existing rules.
- Good, because rule improvements arrive by upgrading a dependency rather than by work here.
- Good, because the repo stays small enough to be about evals, not about linting.
- Bad, because graders depend on external binaries being installed and on their output formats staying stable. Adapters are tested against captured output in `test/fixtures/tool-output/` with an injected `ExecFn`, never against a real binary.
- Bad, because the security surface is wider than it looks: `tool:doc-detective` executes steps embedded in page *bodies*, which the `scripts.allow-frontmatter-commands` flag does **not** gate. The only complete control is restricting the job to same-repo pull requests, which the `verify-docs` job does.
- Neutral, because a native grader remains available when the gap is real. Three exist; the bar is that nothing established covers it.

### Confirmation

The directory split is the record: an adapter in `src/graders/tools/` invokes something, a grader in `src/graders/native/` does not. Every adapter has a unit test driving captured output through a fake `exec`, so the suite stays hermetic — a test that shells out to a real binary is a defect. `test/unit/no-verdict.test.ts` and `test/unit/diagnostic.test.ts` enforce that an unreadable adapter result cannot pass.

## Pros and Cons of the Options

### Wrap existing tools

- Good, because the rule sets — the actual value — come for free and stay current.
- Good, because existing user configuration keeps working.
- Bad, because output formats are an unversioned contract, and a change upstream lands here as a parsing bug.
- Bad, because it inherits upstream's defaults unless each one is pinned deliberately.

### Reimplement natively

- Good, because output is fully controlled and there are no external binaries to install.
- Bad, because the rules are the product, and reimplementing the engine without them ships an empty linter.
- Bad, because it competes with mature projects on their own ground, permanently and while losing.

### Wrap, but reimplement the awkward ones

- Good, because it avoids the worst parsing work.
- Bad, because "awkward to parse" is a property of our code, not of the check's value to a user, so the line would be drawn in the wrong place and would move every time an adapter got annoying.
