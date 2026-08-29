---
status: "accepted"
date: 2026-08-28
decision-makers: [hawkeyexl]
---

# Config discovery walks up to the repository root

## Context and Problem Statement

`loadConfig` looked for `moose.config.yaml` in `cwd` and nowhere else. A repo keeps one config at its root, and people run the CLI from wherever they happen to be — `docs/`, a package directory, a worktree subdirectory, a shell that never left the last `cd`.

Every one of those runs resolved to pure defaults: no named evals, no suites, nothing to reference. And because a page with no resolvable evals is not a *failure*, the run exited 0 having checked nothing, with the config sitting one directory up.

docmeta hit this and fixed it in its proposal 0004. The same shape is here.

## Decision Drivers

- **The failure is silent and green.** Nothing distinguishes "this corpus passes" from "I did not find your config".
- **Every other tool in this space walks up** — git, npm, eslint, tsc. Not doing so is the surprising behavior.
- **An unbounded walk is its own bug.** Reaching past the project finds a config belonging to something else, which is worse than finding none: the tool appears to misread your settings rather than to read someone else's.
- **The unmigrated-config guard must survive the walk.** `loadConfig` already refuses a pre-rename `docevals.config.yaml` in `cwd` rather than falling through to defaults. A walk that checked only for the new filename would step straight past a stale one and land on exactly the silent default-run that guard exists to prevent.

## Considered Options

- **Leave it.** Require `-c` or the right working directory.
- **Walk up to the filesystem root.**
- **Walk up to the repository root** (the directory holding `.git`), then stop.

## Decision Outcome

Chosen option: **walk up to the repository root**, nearest config first, stopping at the directory that holds `.git` — or at the filesystem root when there is none, which is the case for a corpus that is not a git repository at all.

The unmigrated-config check runs at **every level**, not just the first. A stale `docevals.config.yaml` two directories up is exactly as misleading as one in `cwd`, and rather more confusing to find.

With no config anywhere the result is unchanged: built-in defaults, no named evals, no suites. That is a legitimate way to run — a corpus of pages carrying their own inline evals needs no config file — so it stays a valid outcome rather than becoming an error.

### Consequences

- **Good**: running from `docs/` does what the person meant.
- **Good**: the migration error is reachable from wherever the CLI is invoked, not only from the repo root.
- **Neutral**: the nearest config wins, so a subdirectory can deliberately carry its own — which is how the docs site's separate `docs/moose.config.yaml` already behaves when invoked from within `docs/`.
- **Bad, and accepted**: a config *above* the repository root is now ignored where before it was also ignored — no change in practice, but the boundary is a policy rather than an accident, and a monorepo whose real root is above the `.git` directory would need `-c`. `.git` is the boundary every neighbouring tool uses, so a surprise here would be a surprise everywhere.

### Confirmation

`test/unit/config.test.ts` pins five cases: a config found in an ancestor; the nearest winning over a farther one; the walk stopping at the repository root rather than adopting a config from above it; an unmigrated config named rather than stepped past during the walk; and no config anywhere still resolving to defaults.

## Pros and Cons of the Options

### Leave it

- Good, because it is unambiguous about which file was read.
- Bad, because the failure mode is a green run that checked nothing — the worst available outcome for a quality gate.

### Walk to the filesystem root

- Good, because it always finds a config if one exists.
- Bad, because "if one exists" includes one belonging to an unrelated project, and reading a stranger's config is worse than reading none.

### Walk to the repository root

- Good, because it matches what every neighbouring tool does, so the behavior needs no explaining.
- Good, because the boundary is the same one people already think in.
- Neutral: a project without `.git` falls back to the filesystem root, which is the unbounded walk — acceptable because there is no better boundary available, and no repository to escape.
