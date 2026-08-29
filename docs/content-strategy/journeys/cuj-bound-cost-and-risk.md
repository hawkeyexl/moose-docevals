---
id: cuj-bound-cost-and-risk
type: cuj
title: Bound what the gate can spend and what it can execute
personas: [persona-pipeline-owner]
trigger: "The gate is live, and it now runs on pull requests from people outside the organization"
entry_point: docs/src/content/docs/ci/untrusted-pull-requests.mdx
success_criteria: >
  A fork pull request cannot execute its author's code on a runner and cannot reach a provider
  credential, and no run can exceed a spend ceiling set in config.
steps:
  - { stage: "Know what a content file can cause to execute", doc: docs/src/content/docs/ci/untrusted-pull-requests.mdx, exists: true }
  - { stage: "Gate frontmatter-declared commands", doc: docs/src/content/docs/ci/untrusted-pull-requests.mdx, exists: true }
  - { stage: "Understand what that flag does not cover", doc: docs/src/content/docs/ci/untrusted-pull-requests.mdx, exists: true }
  - { stage: "Run the fork path without a credential", doc: docs/src/content/docs/ci/untrusted-pull-requests.mdx, exists: true }
  - { stage: "Set a hard spend ceiling", doc: docs/src/content/docs/ci/cost-and-caching.mdx, exists: true }
  - { stage: "Make repeat runs nearly free", doc: docs/src/content/docs/ci/cost-and-caching.mdx, exists: true }
  - { stage: "Look up the flags and config keys", doc: docs/src/content/docs/reference/configuration.mdx, exists: true }
---

# CUJ: Bound what the gate can spend and what it can execute

**Scope:** the two ways an eval gate can hurt you that an ordinary docs linter cannot — **arbitrary
code execution driven by content files**, and **metered spend in the critical path**. Installing and
operating the gate is [`cuj-ci-wire`](cuj-ci-wire.md); this journey is what keeps that installation
from becoming an incident.

**Trigger.** The gate works and is now exposed to pull requests from outside the organization — or a
finance question arrived about a line item nobody predicted.

**Narrative.** This is the **highest-stakes journey on the site**, and the only one where a
plausible-sounding wrong answer causes real harm rather than a bad experience. It is
[Devin's](../personas/devin-pipeline-owner.md) alone; no other persona is equipped to reason about it,
and no other persona should be relied on to.

There are **two distinct paths from a content file to code running on a runner**, and conflating them
is the trap:

1. **Page frontmatter can declare commands.** `scripts.allow-frontmatter-commands` in config and
   `--no-frontmatter-commands` on the CLI gate this path. This is the one everybody finds.
2. **The `tool:doc-detective` grader executes steps embedded in page bodies.** The flag above does
   **not** gate this path.

A reader who sets `--no-frontmatter-commands` and concludes they are safe against a hostile fork is
wrong, and confidently so. The complete answer is that **the job itself must be gated to same-repo
pull requests**, with forks running a separate `--deterministic-only` job that has no credential and
no doc-detective grader. Any page that presents the flag as sufficient is worse than no page, because
it converts an unknown risk into a false sense of safety. This repo's own `verify-docs` job is built
exactly this way and is the worked example.

The cost half is less dangerous and more likely to end an adoption. Model spend is per-invocation, so
the failure is not one large bill but an unpredictable one — and unpredictable is what gets a check
removed. Two facts do the work: `judge.max-cost-usd` and `fill.max-cost-usd` are **hard ceilings that
abort**, not warnings; and caching is content-addressed, so an unchanged page and an unchanged
assertion never re-judge. Together they make the steady-state cost of a docs PR approximately zero,
which is the number Devin needs and the one that is least obvious from the outside.

**Status.** All 7 steps are served by written pages (3 distinct). Re-check this when the journey changes: a step whose `doc` no longer resolves, or a new step with no page behind it, is the signal that this journey has drifted ahead of the docs.
