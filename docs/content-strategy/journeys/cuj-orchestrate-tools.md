---
id: cuj-orchestrate-tools
type: cuj
title: Fold the linters you already run into one gate
personas: [persona-corpus-owner]
trigger: "Five quality tools, five configs, five output formats, five CI steps"
entry_point: docs/src/content/docs/evals/deterministic-checks.mdx
success_criteria: >
  Vale, markdownlint, docmeta, and a structure linter all report through one moose-docevals run, as evals
  with names and severities, in one output format — and the separate CI steps are gone.
steps:
  - { stage: "See the grader hierarchy and why code comes first", doc: docs/src/content/docs/get-started/how-moose-docevals-works.mdx, exists: true }
  - { stage: "Wrap an existing linter as a tool eval", doc: docs/src/content/docs/evals/deterministic-checks.mdx, exists: true }
  - { stage: "Look up each grader's options", doc: docs/src/content/docs/reference/graders.mdx, exists: true }
  - { stage: "Add the native checks nothing else covers", doc: docs/src/content/docs/reference/graders.mdx, exists: true }
  - { stage: "Run an arbitrary CLI check as a command eval", doc: docs/src/content/docs/evals/deterministic-checks.mdx, exists: true }
  - { stage: "Decide what fails the build and what only reports", doc: docs/src/content/docs/evals/severity-and-findings.mdx, exists: true }
  - { stage: "Test the commands the docs themselves present", doc: docs/src/content/docs/evals/test-your-commands.mdx, exists: true }
---

# CUJ: Fold the linters you already run into one gate

**Scope:** consolidating existing deterministic tooling behind moose-docevals, and reaching for the native
graders where no existing tool covers the gap. It does not cover LLM judging — that is
[`cuj-write-judgeable-assertions`](cuj-write-judgeable-assertions.md) — and it does not cover
converting an ai eval into a deterministic one, which is
[`cuj-cheapen-evals`](cuj-cheapen-evals.md).

**Trigger.** The pipeline already runs several docs linters. Each has its own config file, its own CI
step, and its own output shape, and nobody can say in one sentence what the docs are checked for.

**Narrative.** This journey carries the product's central design claim: **moose-docevals orchestrates, it
does not reimplement.** A reader who expects moose-docevals to replace Vale has misunderstood the tool and
will evaluate it against the wrong competitors. What actually happens is that Vale keeps doing what it
does and its findings arrive as a named eval with a severity, alongside a freshness check and an LLM
verdict, in one report with one exit code.

That framing is also the answer to the cost and trust objections that dominate every other journey. A
pipeline where most evals are `command` or `tool:*` and only a handful are `ai` is cheap, fast, and
explicable — and a reader who walks this journey early is inoculated against the impression that
moose-docevals means "a model grades my docs."

Three things need real estate here. **Severity** is the mechanism that makes consolidation safe: a
newly wrapped linter enters at `warning`, reports without failing, and gets promoted to `error` once
its findings are clean — which is the same ratchet [Iris](../personas/iris-retrofitter.md) uses in
[`cuj-retrofit-corpus`](cuj-retrofit-corpus.md), arrived at from a different direction. **The native
graders** exist only where nothing else covers the gap, and saying which three and why prevents the
reasonable suspicion that moose-docevals is quietly growing its own linter. And **`tool:doc-detective`**
closes the loop: the docs' own commands become testable, which is how this site verifies itself.

**Status.** All 7 steps are served by written pages (5 distinct). Re-check this when the journey changes: a step whose `doc` no longer resolves, or a new step with no page behind it, is the signal that this journey has drifted ahead of the docs.
