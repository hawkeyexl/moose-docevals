---
status: "accepted"
date: 2026-08-13
decision-makers: [hawkeyexl]
---

# Rename to `moose-docevals`, and read config from a shared `moose.config.yaml`

## Context and Problem Statement

docevals is the first of an intended *family* of documentation tools. The name `docevals` claims the
generic term for the whole category while describing only one member, and — more concretely — each
family member that follows would arrive with its own config file. A repo adopting three of them would
carry `docevals.config.yaml`, plus two siblings, each repeating the same `files.include` globs and the
same provider credentials block.

Two questions had to be answered together, because the second one is only cheap while the first is
still open:

1. What is this tool called, on npm and on the command line?
2. Where does its configuration live once it has siblings?

The timing is unusually forgiving. `@hawkeyexl/docevals` has **never been published** — the registry
returns 404, and `RELEASE_ENABLED` is still unset (see [CLAUDE.md](../CLAUDE.md#still-requiring-one-time-setup)).
There are no installs to break, no deprecation notice to write, and no config files in the wild to
migrate. That will not be true after the first publish.

## Decision Drivers

- **The family is the point.** A shared config file is what makes the tools feel like one product
  rather than three that happen to be by the same author.
- **Credentials and file globs are the duplicated part.** Provider blocks and `files.include` are
  near-identical across tools; suites and evals are genuinely docevals-specific.
- **Zero installed base.** A breaking change now costs nothing; the same change after publish costs a
  major version and a migration guide.
- **The command name is load-bearing in CI.** Docs pages carry inline Doc Detective steps that
  *execute* `npx docevals …`, so the command name is not merely documented — it is run by the
  `verify-docs` gate. A half-rename shows up as a red gate, which is the behavior we want.
- **A silent config miss is the dangerous failure.** `loadConfig` falls back to built-in defaults when
  no file is found. A renamed file that the loader does not recognize would not error — it would
  quietly run with no named evals and no suites, and *pass*.

## Considered Options

- **Option 1** — Rename package and command to `moose-docevals`; move config to `moose.config.yaml`
  with a `docevals:` namespace key and sibling keys allowed.
- **Option 2** — Rename the package only; keep the `docevals` command and `docevals.config.yaml`.
- **Option 3** — Rename fully, but keep a flat per-tool `moose-docevals.config.yaml`.
- **Option 4** — Rename fully, and support *both* `moose.config.yaml` and a legacy
  `docevals.config.yaml` indefinitely.

## Decision Outcome

Chosen option: **Option 1**, because it is the only one that actually delivers the shared-config
benefit, and the cost of the break is a rounding error while the package is unpublished.

The concrete contract:

- **npm package**: `moose-docevals`, unscoped. The `@hawkeyexl` scope is dropped; the family prefix now
  carries the ownership signal that the scope used to.
- **Command**: `moose-docevals`. Not `moose` — that is a common word and a likely `PATH` collision, and
  it would reserve the family name for one member, repeating the mistake this ADR corrects.
- **Config file**: `moose.config.yaml`, resolved from the working directory.
- **Config shape**: the entire former root object moves under a `docevals:` key. Keys the schema does
  not know are **permitted at the root** — that is the extension point for the rest of the family.
  Inside `docevals:`, `additionalProperties: false` still holds, so typos are still caught.

```yaml
# moose.config.yaml
docevals:
  version: 1
  provider:
    default: anthropic
  suites:
    core: { targetPassRate: 1.0, evals: [freshness] }

# a sibling tool's settings live here, and docevals ignores them
some-other-tool:
  enabled: true
```

The namespace key stays `docevals:`, **not** `moose-docevals:`. Within a `moose.config.yaml` the family
prefix is already implied by the filename; repeating it in every key would be noise.

A legacy `docevals.config.yaml` is **not** loaded. But because a silently-defaulted run is the worst
outcome (it passes), the loader checks for the old filename when no `moose.config.yaml` is found and
raises a `DocevalsError` naming the migration, rather than falling through to defaults. This is a
one-line guard, not a compatibility path — it errors, it does not read the file.

Renamed alongside, for consistency:

| Surface | Before | After |
|---|---|---|
| Judge cache dir (default) | `.docevals/cache` | `.moose-docevals/cache` |
| Fill cache dir (default) | `.docevals/cache/fill` | `.moose-docevals/cache/fill` |
| Generated script dir (default) | `{docDir}/docevals` | `{docDir}/moose-docevals` |
| Script config dir (default) | `docevals-scripts` | `moose-docevals-scripts` |
| Live-test env var | `DOCEVALS_LIVE` | `MOOSE_DOCEVALS_LIVE` |
| Fixture env var | `DOCEVALS_FILE` | `MOOSE_DOCEVALS_FILE` |
| Frontmatter schema `$id` | `…/docevals/schemas/…` | `…/moose-docevals/schemas/…` |

Deliberately **not** renamed:

- **The `evals:` frontmatter key.** It names the concept, not the tool. Renaming it would churn every
  fixture and docs page for no gain.
- **`DocevalsError` and `DocevalsConfig`.** Internal TypeScript identifiers. "docevals" remains the
  tool's short name *within* the family — that is exactly what the `docevals:` config key asserts — so
  `MooseDocevalsError` would be redundant on top of being 108 mechanical edits.

### Consequences

- Good, because a repo adopting a second family tool adds a key to a file it already has, rather than a
  new file with a duplicated provider block.
- Good, because the break lands while the blast radius is zero. After the first publish this same
  change is a major version plus a migration guide.
- Good, because dropping the npm scope makes the install line (`npm i moose-docevals`) shorter than the
  name it replaces, despite being a longer name.
- Bad, because `moose-docevals` is 8 characters longer to type than `docevals` at the command line, on
  every invocation, forever. This is the real cost and it is accepted knowingly.
- Bad, because the repo now mixes conventions: `moose-docevals` is unscoped while its own dependency
  `@hawkeyexl/inference` stays scoped.
- Bad, because the schema's root is now permissive (`additionalProperties: true`), so a
  `docevlas:` typo at the root is accepted as "some other tool's config" and silently yields a
  defaults-only run. The migration guard covers the one case we know about — the old filename — but not
  a misspelled key. Mitigated by `init` scaffolding the correct key.
- Neutral, because nothing about the eval model, the grader registry, or the judge pipeline changes.
  This is a naming and config-location decision only.

### Confirmation

- `test/unit/config.test.ts` pins the shape: a config nested under `docevals:` parses; sibling root keys
  are ignored rather than rejected; an unknown key *inside* `docevals:` is still an error; and a
  directory containing only `docevals.config.yaml` raises the migration error instead of returning
  defaults.
- `test/unit/schema.test.ts` pins the published frontmatter schema's `$id`.
- The `verify-docs` job executes the docs' inline Doc Detective steps, so any `npx docevals` left in a
  documented command fails CI rather than merely going stale.
- The CI dogfood job runs the built CLI against `test/fixtures/pages/` through the renamed
  `moose.config.yaml`; a missed rename surfaces as the fixture corpus losing its named evals.

## Pros and Cons of the Options

### Option 1 — Full rename, shared `moose.config.yaml` with a `docevals:` key

- Good, because it is the only option where a second family tool costs a key instead of a file.
- Good, because the namespace boundary is explicit, so `moose-docevals` can validate its own subtree
  strictly while ignoring everything else.
- Good, because it is done once, now, while unpublished.
- Bad, because it is the largest single change of the four — 130 tracked files.
- Bad, because it breaks every existing config file. (There are none outside this repo.)

### Option 2 — Rename the package only, keep `docevals` command and config

- Good, because it is nearly free and breaks nothing.
- Good, because the short command survives.
- Bad, because it does not solve the problem that motivated the rename — the second tool still arrives
  with its own config file.
- Bad, because the identity splits: users install `moose-docevals` and then type `docevals`, which is
  the kind of mismatch that generates a support question every time.

### Option 3 — Full rename, flat `moose-docevals.config.yaml`

- Good, because the file name states exactly which tool reads it; no namespacing subtlety.
- Good, because the schema root can stay `additionalProperties: false`, keeping typo detection at every
  level.
- Bad, because it is the status quo with a longer name — three tools still mean three files and three
  copies of the provider block.

### Option 4 — Full rename, support both filenames indefinitely

- Good, because nobody is ever broken.
- Bad, because it maintains two config paths forever to protect an installed base of zero.
- Bad, because "which file wins" becomes a documented rule, a test matrix, and eventually a bug report
  about a stale `docevals.config.yaml` shadowing the real one.
