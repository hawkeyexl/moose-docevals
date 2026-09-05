# moose-docevals

Deterministic and LLM-as-judge evals for documentation pages, driven by frontmatter.

Every quality check on a documentation page is an **eval**: a named, testable assertion with a
**grader** that decides pass or fail. Graders run in preference order. Code first, an AI judge
second, a human last.

## Quickstart

Requires Node.js 24+.

```bash
npm i -D moose-docevals
npx moose-docevals init
npx moose-docevals run --deterministic-only
```

That last command needs no API key and costs nothing, because it runs the deterministic graders only. On a
corpus that has never been checked, it usually finds something.

Declare an assertion in a page's frontmatter:

```yaml
---
title: Installation
last-reviewed: 2026-06-01
evals:
  - use: no-future-promises
  - id: install-command-present
    assertion: The page contains a bash code block with `npm i -g doc-detective`.
    grader: command
---
```

```console
$ npx moose-docevals run docs/ --deterministic-only
docs/actions/goTo.mdx
  FAIL fresh-enough
       error:4 [freshness/stale] Page last reviewed 937 days ago (max 365)
  pass readable
  pass frontmatter-valid

Suites
  reference: 2/3 passed — 67% vs target 100% below target (1 skipped)
```

Exit `1`. A docs regression, caught the way a test catches a code one.

## Documentation

**<https://hawkeyexl.github.io/moose-docevals/>**

Published from `main` on every push, gated on moose-docevals evaluating its own documentation. The
commands these pages present are executed against the fixture corpus before the site ships.

| Section | Covers |
|---|---|
| [Get started](https://hawkeyexl.github.io/moose-docevals/get-started/) | Install, first assertion, first finding |
| [How moose-docevals works](https://hawkeyexl.github.io/moose-docevals/get-started/how-moose-docevals-works/) | The eval, the grader hierarchy, how a verdict is reached |
| [Write evals](https://hawkeyexl.github.io/moose-docevals/evals/) | The frontmatter contract, assertion craft, deterministic checks, suites, citing source code |
| [Adopt at scale](https://hawkeyexl.github.io/moose-docevals/adopt/) | `fill`, retrofitting a legacy corpus, `promote` |
| [Run it in CI](https://hawkeyexl.github.io/moose-docevals/ci/) | Recipes, exit codes, cost, and fork safety |
| [Trust the judge](https://hawkeyexl.github.io/moose-docevals/judge/) | Ensemble, confidence zones, calibration, providers |
| [Fix a failing eval](https://hawkeyexl.github.io/moose-docevals/fix/) | For contributors whose PR just went red |
| [Reference](https://hawkeyexl.github.io/moose-docevals/reference/) | CLI, config, frontmatter, graders, output, state |

To run the site locally:

```bash
cd docs && npm ci && npm run dev
```

## Commands

| Command | Purpose |
|---|---|
| `moose-docevals run [globs]` | Run all evals, deterministic graders first, then the AI judge |
| `moose-docevals list` | Dry run, showing each page's resolved eval plan |
| `moose-docevals generate` | Generate scripts for command evals missing a command |
| `moose-docevals fill [--dry-run]` | Propose new frontmatter evals with an LLM, gated on confidence |
| `moose-docevals promote [--write]` | Convert ai evals that could be deterministic |
| `moose-docevals review <file> <eval> <pass\|fail>` | Record a human verdict |
| `moose-docevals calibrate` | Score the judge against a human-verified golden set |
| `moose-docevals cite add <page> <path:L1-L2>` | Pin the source lines a sentence depends on, by hash and commit |
| `moose-docevals cite refresh [globs]` | Mint unminted citations and rewrite moved ranges in place |
| `moose-docevals init` | Scaffold a starter config |

Exit codes: `0` pass · `1` failures, errors, or a suite below target · `2` usage or operational
error. Full flag reference in [the CLI docs](https://hawkeyexl.github.io/moose-docevals/reference/cli/).

## The published schema

moose-docevals ships the frontmatter JSON Schema as a package artifact, so any validator can check your
pages:

```bash
docmeta validate --schema node_modules/moose-docevals/schemas/frontmatter-1.2.0.json docs/
```

```js
import { frontmatterSchema, frontmatterSchemaPath } from "moose-docevals";
```

## Contributing

See [CLAUDE.md](CLAUDE.md) for repo conventions, including red/green TDD, Conventional Commits, and
the ADR rule. Decisions live in [`adrs/`](adrs); the docs content strategy lives in
[`docs/content-strategy/`](docs/content-strategy/).

## License

MIT
