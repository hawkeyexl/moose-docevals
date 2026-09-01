---
status: "accepted"
date: 2026-08-31
decision-makers: [hawkeyexl]
---

# Judge locally: take `llama-cpp` from the inference layer, pinned to a concrete model

## Context and Problem Statement

Every judged run to date has cost API tokens, which is the main reason the AI judge has never been run over a corpus this project owns: `docs/.moose-docevals-cache/` holds nothing but its own README. The shared inference layer has meanwhile grown a complete local-inference subsystem — a `llama-cpp` provider, a model catalog, weight auto-install, and provider detection — that moose-docevals cannot see, because this repo is pinned at `@hawkeyexl/inference@^0.1.0` against a published `0.3.1`.

Two questions follow. Which provider does the judge use when we want electricity rather than tokens, and — because the provider *and the model* are both judge cache-key inputs — what exactly gets written into `moose.config.yaml` so that committed cache fixtures replay on a machine that is not this one?

## Decision Drivers

- **Cost.** Judging our own docs, and re-judging them after every prompt revision, should not be metered.
- **The cache key is the constraint.** `cacheKey` composes provider, model, `PROMPT_VERSION`, runs, temperature, page body, and eval. Anything non-deterministic in provider or model makes committed fixtures unreplayable, which is what `verify-docs` depends on.
- **The library owns providers, this repo owns config.** Three copies of provider code drifted apart once already; a fix belongs upstream.
- **`resolveProviderIdentity` must stay synchronous.** It is on the cache-key path, and `makeProvider` is called synchronously inside `run`'s degrade-to-deterministic try/catch.
- **A config typo must be a usage error, not a stack trace.** `cli.ts` maps only `DocevalsError` to exit 2.

## Considered Options

- **A local OpenAI-compatible endpoint** through the existing `openai` provider's `base-url` (Ollama, LM Studio, vLLM).
- **`llama-cpp` with the library's default `model: "auto"`**, or any tier selector.
- **`llama-cpp` with a concrete model pinned in config.**
- **`provider: "auto"`**, the library's new detection mode.

## Decision Outcome

Chosen option: **upgrade to `^0.3.1` and add `llama-cpp` as a configured provider, defaulting to the concrete model `qwen3.5-4b`** — never a selector, and never `provider: "auto"`.

The upgrade itself was free: docmeta `^4.12.0` already depended on `@hawkeyexl/inference@^0.3.1`, so this repo had been resolving *two* copies — our `0.1.0` hoisted and docmeta's `0.3.1` nested. The bump deduplicates them to one. No provider code lands here; `providerSpecFor` gains a `case` and the config gains a section, per the Config↔CLI pattern.

The selector question is settled by the library rather than by taste: `resolveProviderIdentity` **throws** on `auto`, `fast`, `balanced`, and `quality` alike, because picking a tier probes GPU memory and cannot be done synchronously. Even if it could, a selector resolves per-machine, so fixtures generated here would miss everywhere else. `provider: "auto"` fails for both reasons at once, and additionally forces the async resolvers.

Config keys are kebab-case per ADR 01010 — `model`, `models-directory`, `thought-tokens`, `max-tokens`. `thought-tokens` defaults to `0`, matching the library: a grammar constrains generation from token 0, so an unbudgeted model begins reasoning and is cut off mid-thought. The library's `runtime` seam is deliberately **not** exposed, because it takes an object rather than a value a YAML file can carry.

### Consequences

- Good, because judging a corpus now costs electricity, which is what makes re-judging after a `PROMPT_VERSION` bump affordable rather than a budget decision.
- Good, because llama.cpp constrains output with a **grammar** from token 0, so the verdict schema is enforced by construction — stronger than asking a remote model to honour JSON-schema mode.
- Good, because the duplicate inference copy is gone.
- Bad, because a corpus's committed fixtures are now bound to a specific local model: changing `provider.llama-cpp.model` invalidates every one of them. That is the price of replayable fixtures, and it applies equally to the API providers — it is simply more visible here, where the model is a thing you might casually swap.
- Bad, because the first local run downloads weights, which is slow and large. It happens once, and never in CI, which replays the cache and reaches nothing.
- Neutral, because a user who wants a selector can still pass `--model auto`; they get a `DocevalsError` explaining why it cannot be resolved, rather than silence.

### Confirmation

`test/unit/provider.test.ts` pins the mapping, the concrete default, and that a selector raises `DocevalsError` naming it. It also asserts our resolver agrees with the library's for **every** provider name, so a future library change to identity resolution fails here rather than silently repartitioning the cache. `test/unit/config.test.ts` pins the defaults, an unknown key inside the section, and that a camelCase key is named with the kebab it should be.

## Pros and Cons of the Options

### A local OpenAI-compatible endpoint

- Good, because it needs no code change at all — `base-url` already exists.
- Bad, because structured output depends on the server *and* the model honouring JSON-schema mode; a model that cannot hold the shape produces errored runs, which count against consensus and push evals to human-review.
- Bad, because it needs a separate server process running before any judged command, which is a second thing to get right in every recipe.

### `llama-cpp` with a selector

- Good, because it picks a model suited to the machine.
- Bad, because `resolveProviderIdentity` throws on it — it is not merely inadvisable, it does not work on the synchronous path the cache key needs.
- Bad, because the resolved tier varies by machine, so fixtures would replay only where the same tier is chosen.

### `llama-cpp` with a concrete model

- Good, because provider and model are both deterministic, which is exactly what cache-key material must be.
- Good, because it keeps `makeProvider` and `resolveProviderIdentity` synchronous.
- Bad, because the default will age: `qwen3.5-4b` is today's `balanced` alias, and someone must eventually choose a successor knowing it invalidates existing fixtures.

### `provider: "auto"`

- Good, because it is the friendliest first-run experience — the library finds whatever the machine can use.
- Bad, because the *detected* provider is cache-key material, so fixtures would replay only on machines that detect identically.
- Bad, because it forces `makeProviderAsync`/`resolveProviderIdentityAsync` through call sites that are synchronous today.
