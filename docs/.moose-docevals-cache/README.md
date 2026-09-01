# Committed judge cache for the docs corpus

**This directory is version-controlled on purpose.** It is not a build artifact.

`docs/moose.config.yaml` points `judge.cacheDir` and `fill.cacheDir` here rather than at the
default `.moose-docevals/cache`, which the repo-root `.gitignore` excludes. Committing the cache is what
lets the `verify-docs` CI job replay LLM verdicts for the docs site **with no `ANTHROPIC_API_KEY`** —
the same guarantee the deterministic graders already give, extended to the judged evals.

## What is in here

One fixture per judged eval — currently 33, one for each page carrying
`no-future-promises`. `defaults.suite` is `docs-page-full`, so the judge runs as part of the gate
rather than alongside it.

**`states-its-purpose` is defined but deliberately not in the suite.** Broadening its assertion so it
accepted strictly more pages moved four pages from pass to fail; verdicts that are not a monotonic
function of the assertion are not measuring the assertion, so it is kept out and run by hand with
`--eval states-its-purpose`. See ADR `01028-a-local-judge-gates-locatable-properties-only.md` — this
section previously claimed the opposite.

The 34th page, `evals/regression-vs-capability.mdx`, takes the narrower `docs-page-meta` suite via
`eval-suite:` frontmatter: its prose contains "no promises about unreleased features" as an *example*
of what a regression eval guards, which the judge reads as the page making that claim.

`npm run docs:check-cache` asserts every judged eval has a fixture here, and CI runs it **before**
`docs:verify`. That ordering matters: a missing fixture is a cache miss, and a miss does not fail the
run on its own — it reaches for a provider, errors, and lands in `needs-review`, which is excluded
from the pass rate.

## Regenerating

Cache keys include `PROMPT_VERSION` (`src/judge/prompt.ts`) and `FILL_PROMPT_VERSION`
(`src/fill/prompt.ts`). **Bumping either invalidates every fixture here and turns `verify-docs` red
until it is regenerated** — which is deliberate. A prompt change can change a verdict, and the pages
present those verdicts as documented behavior, so the breakage forces someone to re-read them rather
than letting a stale example survive a prompt revision.

```bash
npm run build && npm run docs:refresh-cache
```

Then review the diff before committing. A verdict that flipped is a signal about the page, not noise
to be committed past.

See ADR `01004-test-the-docs-through-moose-docevals-itself.md`.
