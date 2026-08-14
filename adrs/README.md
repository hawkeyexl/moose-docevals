# Architecture Decision Records

Every **behavior change** in moose-docevals ships with an ADR here. The ADR records the intended behavior and the reasoning — write it before or alongside the code, so it is the reviewable source of truth rather than an afterthought. The full rule lives in [CLAUDE.md](../CLAUDE.md#architecture-decision-records-required).

## Conventions

- **Format**: [MADR 4.0.0](https://adr.github.io/madr/). Start from [template.md](template.md).
- **Filename**: `NNNNN-kebab-case-title.md`, 5-digit zero-padded.
- **Numbering starts at `01000`** and increments. The range `00001`–`00999` is **reserved** to backfill pre-existing architectural decisions later — do not use it for new ones.
- **Scope**: decisions (behavior, contracts, trade-offs), not mechanical changes. Pure refactors, dependency bumps, typo fixes, and style changes don't need one. If a change alters observable behavior or a public contract, it does.

## Index

| ADR | Title | Status |
|---|---|---|
| [01000](01000-publish-the-frontmatter-schema-from-this-repo.md) | Publish the frontmatter schema from this repo | accepted |
| [01001](01001-fill-proposes-llm-evals-with-confidence-gating.md) | `fill` proposes llm-graded evals with a confidence gate | accepted |
| [01002](01002-take-inference-from-the-shared-library.md) | Take the inference layer from `@hawkeyexl/inference` | accepted |
| [01003](01003-cuj-first-docs-site-and-content-strategy.md) | A CUJ-first documentation site, driven by a co-located content strategy | accepted |
| [01004](01004-test-the-docs-through-moose-docevals-itself.md) | Test the docs site through moose-docevals itself, with committed cache fixtures | accepted |
| [01005](01005-fix-the-doc-detective-adapter-invocation-and-finding-granularity.md) | Fix the Doc Detective adapter: invocation, failure detection, and finding granularity | accepted |
| [01006](01006-publish-the-docs-site-to-github-pages.md) | Publish the docs site to GitHub Pages, gated on moose-docevals evaluating itself | accepted |
| [01007](01007-validate-format-centrally-as-a-usage-error.md) | Validate `--format` centrally, and reject an unknown value as a usage error | accepted |
| [01008](01008-rename-to-moose-docevals-and-share-one-family-config.md) | Rename to `moose-docevals`, and read config from a shared `moose.config.yaml` | accepted |

## To backfill

These decisions predate the ADR rule and are currently recorded only in [CLAUDE.md](../CLAUDE.md#design-decisions). They should each become an ADR:

- One unified concept: the eval (rejecting the runners/evals split).
- Generated check scripts are files referenced as commands, never inline in frontmatter.
- `type` defaults to `regression` rather than `capability`.
- Level 1 orchestrates existing tools rather than reimplementing them.
