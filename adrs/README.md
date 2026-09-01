# Architecture Decision Records

Every **behavior change** in moose-docevals ships with an ADR here. The ADR records the intended behavior and the reasoning — write it before or alongside the code, so it is the reviewable source of truth rather than an afterthought. The full rule lives in [CLAUDE.md](../CLAUDE.md#architecture-decision-records-required).

## Conventions

- **Format**: [MADR 4.0.0](https://adr.github.io/madr/). Start from [template.md](template.md).
- **Filename**: `NNNNN-kebab-case-title.md`, 5-digit zero-padded.
- **Numbering starts at `01000`** and increments. The range `00001`–`00999` is **reserved** to backfill pre-existing architectural decisions later — do not use it for new ones.
- **Scope**: decisions (behavior, contracts, trade-offs), not mechanical changes. Pure refactors, dependency bumps, typo fixes, and style changes don't need one. If a change alters observable behavior or a public contract, it does.
- **Supersede, never amend.** An ADR records what was decided *at the time it was written*, on the evidence available then — which makes the wrong ones as valuable as the right ones, because they are the only account of why a decision looked correct before it wasn't. When reality moves past one, write a new ADR that says what it supersedes and why. Do not edit the old file to match what shipped. The one exception is the `status:` line, which is an index entry rather than part of the record: mark it `superseded by ADR-NNNNN` and change nothing else — not the title, not the decision, not the reasoning, however wrong they read afterwards.

## Index

| ADR | Title | Status |
|---|---|---|
| [01000](01000-publish-the-frontmatter-schema-from-this-repo.md) | Publish the frontmatter schema from this repo | superseded by [01009](01009-implement-the-docmeta-evals-vocabulary.md) |
| [01001](01001-fill-proposes-llm-evals-with-confidence-gating.md) | `fill` proposes llm-graded evals with a confidence gate | superseded by [01011](01011-fill-writes-a-durable-provenance-trail.md) |
| [01002](01002-take-inference-from-the-shared-library.md) | Take the inference layer from `@hawkeyexl/inference` | accepted |
| [01003](01003-cuj-first-docs-site-and-content-strategy.md) | A CUJ-first documentation site, driven by a co-located content strategy | accepted |
| [01004](01004-test-the-docs-through-moose-docevals-itself.md) | Test the docs site through moose-docevals itself, with committed cache fixtures | accepted |
| [01005](01005-fix-the-doc-detective-adapter-invocation-and-finding-granularity.md) | Fix the Doc Detective adapter: invocation, failure detection, and finding granularity | accepted |
| [01006](01006-publish-the-docs-site-to-github-pages.md) | Publish the docs site to GitHub Pages, gated on moose-docevals evaluating itself | accepted |
| [01007](01007-validate-format-centrally-as-a-usage-error.md) | Validate `--format` centrally, and reject an unknown value as a usage error | accepted |
| [01008](01008-rename-to-moose-docevals-and-share-one-family-config.md) | Rename to `moose-docevals`, and read config from a shared `moose.config.yaml` | accepted |
| [01009](01009-implement-the-docmeta-evals-vocabulary.md) | Implement `docmeta:evals` as the frontmatter vocabulary, and publish a schema for it | accepted |
| [01010](01010-kebab-case-is-the-file-vocabulary.md) | Kebab-case is the file vocabulary — frontmatter, config, and grader options | accepted |
| [01011](01011-fill-writes-a-durable-provenance-trail.md) | `fill` writes a durable `eval-provenance` trail | accepted |
| [01012](01012-config-discovery-walks-up-to-the-repository-root.md) | Config discovery walks up to the repository root | accepted |
| [01013](01013-track-docmeta-4x-and-name-the-schema-set.md) | Track docmeta 4.x, and make `tool:docmeta` name its own schema set | accepted |
| [01014](01014-sarif-and-junit-reporters.md) | SARIF and JUnit reporters, and a suite stamped on every result | accepted |
| [01015](01015-ship-a-composite-action-after-the-first-publish.md) | Ship a composite Action and pre-commit hook — after the first npm publish | accepted (nothing to ship yet) |
| [01016](01016-golden-cases-are-seeded-from-reviews-and-gated-on-human-confirmation.md) | Golden cases are seeded from reviews, and gated on human confirmation | accepted |
| [01017](01017-a-committed-baseline-ratchets-a-legacy-corpus.md) | A committed baseline ratchets a legacy corpus | accepted |
| [01018](01018-selecting-evals-suspends-suite-enforcement.md) | Selecting a subset of evals suspends suite enforcement | accepted |
| [01019](01019-a-turn-budget-replaces-the-cost-budget.md) | A turn budget replaces the cost budget, and cost accounting is removed | accepted |
| [01020](01020-unreadable-tool-output-is-a-finding-not-a-pass.md) | Unreadable tool output is a finding, not a pass | superseded by [01022](01022-a-grader-that-reached-no-verdict-fails-the-eval.md) |
| [01021](01021-a-config-eval-is-one-generation-target.md) | A config-defined eval is one generation target, however many pages use it | accepted |
| [01022](01022-a-grader-that-reached-no-verdict-fails-the-eval.md) | A grader that reached no verdict fails the eval, at any severity | accepted |
| [01023](01023-the-diagnostic-invariant-is-enforced-by-enumeration.md) | The diagnostic invariant is enforced by enumeration, not by inspection | accepted |
| [01024](01024-judge-locally-with-a-pinned-llama-cpp-model.md) | Judge locally: take `llama-cpp` from the inference layer, pinned to a concrete model | accepted |
| [01026](01026-an-errored-ensemble-is-never-cached.md) | An ensemble containing an errored run is never cached | accepted |

## To backfill

These decisions predate the ADR rule and are currently recorded only in [CLAUDE.md](../CLAUDE.md#design-decisions). They should each become an ADR:

- One unified concept: the eval (rejecting the runners/evals split).
- Generated check scripts are files referenced as commands, never inline in frontmatter.
- `type` defaults to `regression` rather than `capability`.
- Level 1 orchestrates existing tools rather than reimplementing them.
