# Committed judge cache for the docs corpus

**This directory is version-controlled on purpose.** It is not a build artifact.

`docs/moose.config.yaml` points `judge.cacheDir` and `fill.cacheDir` here rather than at the
default `.moose-docevals/cache`, which the repo-root `.gitignore` excludes. Committing the cache is what
lets the `verify-docs` CI job replay LLM verdicts for the docs site **with no `ANTHROPIC_API_KEY`** —
the same guarantee the deterministic graders already give, extended to the judged evals.

## Current state: empty

The site is currently section-index stubs, and the `docs-page` suite contains only deterministic
evals. Judging placeholder prose would produce fixtures that assert nothing, so there are none yet.

The LLM evals (`no-future-promises`, `states-its-purpose`) are defined in the config and collected in
a `docs-page-full` suite. **When the first real page lands**, switch `defaults.suite` to
`docs-page-full` and run:

```bash
npm run docs:refresh-cache
```

with a provider configured, then commit what appears here.

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
