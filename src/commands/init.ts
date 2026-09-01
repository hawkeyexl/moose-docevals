/** `moose-docevals init` — scaffold a starter moose.config.yaml. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DocevalsError } from "../types.js";
import { DEFAULT_CONFIG_FILENAME } from "../core/config.js";

const STARTER_CONFIG = `# moose.config.yaml — shared configuration for the moose family of tools.
# Each tool reads its own top-level key; moose-docevals reads "docevals:".
# Docs: https://github.com/hawkeyexl/moose-docevals
docevals:
  version: 1

  files:
    include:
      - "docs/**/*.{md,mdx}"
    exclude:
      - "**/node_modules/**"

  defaults:
    # Suite applied to pages without an eval-suite frontmatter key. Naming the
    # suite defined at the bottom of this file is what makes a fresh corpus
    # check anything at all: with "null", a page carrying no eval frontmatter
    # resolves zero evals, and a run over zero evals is a usage error rather
    # than a green build (ADR 01030).
    suite: default
    fail-fast: false
    concurrency: 4

  provider:
    default: anthropic
    anthropic:
      model: claude-sonnet-4-5 # pin your judge model; never "latest"
      api-key-env: ANTHROPIC_API_KEY
    # openai:
    #   base-url: http://localhost:11434/v1   # any OpenAI-compatible server
    #   model: llama3.1:8b
    # claude-cli:
    #   model: claude-sonnet-4-5             # uses local CLI auth, no API key

  judge:
    ensemble-runs: 3 # 3 isolated runs per eval; agreement is signal
    temperature: 0
    zones:
      auto-pass: 0.8 # unanimous pass + mean confidence >= 0.8
      auto-fail: 0.8
    false-positive-alert: 0.15
    cache-dir: .moose-docevals/cache

  scripts:
    dir: "{docDir}/moose-docevals" # generated check scripts live beside the docs
    config-dir: moose-docevals-scripts
    allow-frontmatter-commands: true

  evals:
    no-future-promises:
      type: regression
      assertion: The page makes no claims about unreleased or future functionality.
      grader: ai
      evidence: All prose sections
      examples:
        pass: Describes only shipped behavior.
        fail: Says "coming soon" or references an unreleased version.
    fresh-enough:
      assertion: Page was reviewed within the last year.
      grader: tool:freshness
      options:
        field: last-reviewed
        max-age-days: 365
      severity: warning

  suites:
    default:
      target-pass-rate: 1.0 # regression suites target ~100%
      evals: [no-future-promises, fresh-enough]
`;

export function runInit(cwd = process.cwd()): string {
  const path = resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (existsSync(path)) {
    throw new DocevalsError(`${DEFAULT_CONFIG_FILENAME} already exists`);
  }
  writeFileSync(path, STARTER_CONFIG);
  return path;
}
