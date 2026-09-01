---
status: "accepted"
date: 2026-08-31
decision-makers: [hawkeyexl]
---

# The docs corpus is judged, not only executed, by a pinned local model

## Context and Problem Statement

[ADR 01004](01004-test-the-docs-through-moose-docevals-itself.md) established that this repo's documentation site is verified by moose-docevals itself, with committed cache fixtures so CI can replay judged verdicts without an API key. Only half of that shipped. `defaults.suite` was `docs-page` — deterministic checks only — and `docs/.moose-docevals-cache/` contained exactly one file: its own README.

So the AI judge, the tool's headline capability, had never been run against any corpus this project owns, and the prose on 34 published pages was ungated. The reason recorded in the config was that the site was "section-index stubs"; by the time this was picked up, all 34 pages were written and that reason was stale.

Turning it on raises a question the deterministic half never had to answer: **who judges, and what does that commit us to?**

## Decision Drivers

- A judged verdict, once committed as a fixture, becomes the replayed record of documented behavior. It is not a transient result.
- CI must reach no provider at all. Replay is the only path there, so a cache miss has to surface as an error rather than a quiet pass.
- Re-judging a whole corpus is not rare: any `PROMPT_VERSION` bump invalidates every fixture. If that is metered, it becomes a budget decision and the prompt stops improving.
- `cacheKey` composes provider **and model**. Whatever judges the corpus is therefore frozen alongside the prompt version.

## Considered Options

- **Stay deterministic-only.** Keep the gate honest and leave prose ungated.
- **Judge with a metered API** (`anthropic`), the existing default.
- **Judge with a pinned local model** via the `llama-cpp` provider (ADR 01024).

## Decision Outcome

Chosen option: **judge with a pinned local model**, and switch `defaults.suite` to `docs-page-full`.

`docs/moose.config.yaml` names `provider.default: llama-cpp` and `model: qwen3.5-9b` explicitly rather than relying on the config default, and the 33 resulting fixtures are committed. A red `verify-docs` now means the *prose* failed, not only that a command broke.

The model is spelled out on purpose. Provider and model are both cache-key inputs, so a shifting default would silently repartition the cache; naming them makes the coupling visible at the place someone would otherwise change it casually. Changing either invalidates all 33 fixtures and turns `verify-docs` red until `npm run docs:refresh-cache` regenerates them — which is the same deliberate breakage `PROMPT_VERSION` already causes, for the same reason.

Two corpus-specific exceptions were needed, and both are recorded where they apply rather than hidden in a flag:

- **`evals/regression-vs-capability.mdx` takes a narrower suite** (`docs-page-meta`) via `eval-suite:` frontmatter. Its prose contains "no promises about unreleased features" as an *example* of what a regression eval guards, which `no-future-promises` reads as the page making that claim. A page that documents an eval in prose sits outside what that eval can judge. Narrower than skipping the page: everything else still runs.
- **The holistic eval is defined but not gated** — see [ADR 01028](01028-a-local-judge-gates-locatable-properties-only.md), which this decision surfaced rather than anticipated.

`npm run docs:refresh-cache` also stopped deleting the cache directory's committed README, which it had been doing on every invocation since the directory existed.

### Consequences

- Good, because the tool now demonstrates its headline capability on a corpus it owns, which it previously did not.
- Good, because re-judging costs electricity, so a prompt revision is a decision about correctness rather than about spend.
- Good, because the first run found two real defects in the tool (ADRs 01026, 01027) and one class of authoring hazard, none of which unit tests had surfaced. Running the thing against real content is not the same as testing it.
- Bad, because the corpus's fixtures are now bound to one machine's model choice. Regenerating them requires that model, so a contributor without it cannot refresh the cache — they can still run `--suite docs-page`, which needs nothing.
- Bad, because a cold refresh is slow: roughly 33 evals × 3 runs of local inference. It is a one-time cost per prompt revision, not per run.
- Neutral, because `docs-page` is kept as an explicit escape hatch for a run that must not touch the judge at all.

### Confirmation

`verify-docs` in `ci.yml` runs `docs:verify` with no API key and no local model available, so it exercises replay exclusively — a miss surfaces as a provider error rather than a pass. The check that fixtures are complete is that a second local `docs:verify` reports every eval as cached; the run that established this reported `33 cached` out of 33.

## Pros and Cons of the Options

### Stay deterministic-only

- Good, because every verdict is reproducible with no model anywhere.
- Good, because it cannot go stale on a prompt change.
- Bad, because the prose stays ungated, which is the gap this was meant to close.
- Bad, because the project would ship an LLM-as-judge tool with no evidence of it working on documentation the authors control.

### Judge with a metered API

- Good, because the models are stronger, which matters most for exactly the subjective evals that turned out to be hardest.
- Good, because it needs no local hardware, so any contributor can refresh.
- Bad, because every `PROMPT_VERSION` bump becomes a spending decision, which is how prompts stop being improved.
- Bad, because it puts the content of every page through a third party on each refresh — an answer this project would rather not have to give.

### Judge with a pinned local model

- Good, because refreshing is free, so the fixtures can be regenerated whenever correctness requires it.
- Good, because no page content leaves the machine.
- Bad, because it binds the fixtures to a specific model, and a weaker model turned out to be capable of only some of the evals.
