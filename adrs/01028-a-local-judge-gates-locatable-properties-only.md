---
status: "accepted"
date: 2026-08-31
decision-makers: [hawkeyexl]
---

# A local judge gates locatable properties, not holistic ones

## Context and Problem Statement

Turning the AI judge on over this repo's own 34 documentation pages was meant to close the gap where the site's prose was ungated (ADR 01004, ADR 01025). Two `ai` evals were defined for it: `no-future-promises` — does the page's prose claim something unshipped — and `serves-one-journey`, later `states-its-purpose` — does the page make clear near the top what it is for.

One of them works. The other does not, and the reason is not fixable by wording.

## Decision Drivers

- A gate that produces verdicts nobody trusts gets removed, taking the trustworthy checks with it.
- The corpus is small enough (34 pages) that every verdict was checkable by hand, which is a luxury that will not exist later.
- Verdicts must be a **function of the assertion**. If they are not, the assertion is not what is being measured, and iterating on wording is superstition.
- The committed cache makes this permanent: whatever ships becomes the replayed record of documented behavior.

## Considered Options

- **Keep both evals** and accept the failures as a backlog.
- **Reword the failing eval again** — a fourth attempt.
- **Move to a larger model.**
- **Gate on the eval that works; define but do not gate the one that does not.**

## Decision Outcome

Chosen option: **gate on `no-future-promises`; keep `states-its-purpose` defined but out of `docs-page-full`.**

The evidence is a monotonicity violation. `serves-one-journey` was reworded into `states-its-purpose` with an assertion that is **strictly broader** — it added "or the ground it covers" as an additional way to satisfy the same claim, accepting everything the previous wording accepted plus more. Four pages moved from **pass to FAIL**: `ci/cost-and-caching.mdx`, `fix/index.mdx`, `judge/human-review.mdx`, and `reference/output-and-exit-codes.mdx`.

Nothing else changed. The eval's *name* is not prompt surface — `buildUserContent` sends only the assertion, `evidence`, the anchor examples, and the page body — so the rename was invisible to the judge. Temperature is 0 and the ensemble is 3 runs. A strictly weaker requirement producing more failures means the verdicts are not tracking the assertion.

Model size does not rescue it. `qwen3.5-4b` and `qwen3.5-9b` were both run over the full corpus: **5 of 68 verdicts differed** between them, and `serves-one-journey` got *worse* at 9b (0/34 passing, versus 1/34). Doubling the parameter count changed nothing that mattered.

By contrast `no-future-promises` held at **33 of 34 across three different wordings**, and its single failure is explainable rather than mysterious: `evals/regression-vs-capability.mdx` contains the sentence "no promises about unreleased features" in its own prose, as an example of what a regression eval guards.

The distinction that predicts which is which is **locatable versus holistic**. `no-future-promises` asks whether a specific kind of sentence appears — the judge can point at the text that decides it. `states-its-purpose` asks for a judgment about the page as a whole, where nothing in the text settles the answer and small prompt changes move it freely.

### Consequences

- Good, because the gate now consists only of checks whose verdicts survived hand-verification of all 34 pages.
- Good, because it names a predictor — locatable versus holistic — that generalizes past this corpus and this model, and is now taught in `evals/write-good-assertions.mdx`.
- Good, because `states-its-purpose` stays defined and runnable with `--eval states-its-purpose`, so it can be re-tested against a stronger judge without being rewritten.
- Bad, because the property it was meant to enforce — that a page says what it is for — is now ungated, and it is a property the CUJ-first IA genuinely cares about. It returns as a human review item rather than an automated one.
- Bad, because "locatable versus holistic" is a heuristic drawn from two evals on one corpus. It is a hypothesis with supporting evidence, not a law.
- Neutral, because one page (`evals/regression-vs-capability.mdx`) takes a narrower suite via `eval-suite: docs-page-meta`. A page that documents an eval in prose sits outside what that eval can judge, and saying so in frontmatter is narrower and more honest than skipping the page.

### Confirmation

The suite membership in `docs/moose.config.yaml` is the enforcement, with the monotonicity result recorded in a comment beside it. `verify-docs` replays the committed cache with no provider reachable, so the gate cannot silently start judging again. If `states-its-purpose` is ever restored, the check that it belongs is the same one that removed it: broaden the assertion and confirm no page moves from pass to fail.

## Pros and Cons of the Options

### Keep both evals, treat failures as a backlog

- Good, because it keeps the standard visible rather than quietly dropping it.
- Bad, because the failures are not a backlog — they are not reproducibly *about* anything, so there is no work that would clear them.
- Bad, because `target-pass-rate: 1.0` means the suite never goes green, and a permanently red gate is an ignored gate.

### Reword a fourth time

- Good, because three attempts is not proof that a fourth fails.
- Bad, because the monotonicity violation says the verdicts do not track the wording. Iterating on an input the output does not depend on is not engineering.

### Move to a larger model

- Good, because holistic judgment is exactly where more capable models should help.
- Bad, because it was tried: 4b → 9b changed 5 of 68 verdicts and made this eval worse. A materially stronger model might succeed, but it would not be a *local* one, which was the point.

### Gate on the working eval only

- Good, because every remaining verdict was hand-checked against the page.
- Good, because it distinguishes the two kinds of eval rather than treating "ai grader" as one capability.
- Bad, because it narrows what the gate covers, and the narrowing is invisible unless someone reads the suite.
