/**
 * `moose-docevals run` — execute the full pipeline. Deterministic graders run
 * first (cheap-first ordering); the AI judge stage runs when a provider is
 * available and not disabled.
 */
import { runEvals, type EngineReport, type JudgeFn, type RunOptions } from "../core/engine.js";
import { loadConfig, type DocevalsConfig } from "../core/config.js";
import { render, type ReportFormat } from "../reporters/index.js";
import { makeJudge } from "../judge/judge.js";
import { makeProvider } from "../judge/provider.js";
import { makeGenerateScripts } from "../graders/scriptgen.js";
import type { GenerateFn } from "../core/engine.js";
import { DocevalsError } from "../types.js";

export interface RunCommandOptions {
  config?: string;
  format?: ReportFormat;
  deterministicOnly?: boolean;
  aiOnly?: boolean;
  frontmatterCommands?: boolean;
  generate?: boolean;
  cache?: boolean;
  failOnReview?: boolean;
  provider?: string;
  model?: string;
  runs?: number;
  maxTurns?: number;
  evalNames?: string[];
  suite?: string;
  /** Evaluate only pages that differ between this git ref and HEAD (ADR 01029). */
  since?: string;
  baseline?: string | boolean;
  writeBaseline?: string | boolean;
  toolVersion?: string;
  cwd?: string;
}

export async function runRun(
  globs: string[],
  options: RunCommandOptions = {},
  engineOverrides: Partial<RunOptions> = {},
): Promise<EngineReport> {
  const cwd = options.cwd ?? process.cwd();
  const judgeOptions = {
    provider: options.provider,
    model: options.model,
    runs: options.runs,
    noCache: options.cache === false,
    maxTurns: options.maxTurns ?? null,
  };

  // Loaded once and passed through to the engine — a run must not validate
  // the config twice or observe two different versions of it.
  const config: DocevalsConfig = loadConfig(options.config, cwd);

  // Build the judge and generation stages unless deterministic-only or an
  // override supplies them. Both share one provider.
  let judge: JudgeFn | undefined;
  let generateScripts: GenerateFn | undefined;
  if (!("judge" in engineOverrides) || !("generateScripts" in engineOverrides)) {
    try {
      const provider = makeProvider(config, judgeOptions);
      if (!options.deterministicOnly) judge = makeJudge({ provider, root: cwd });
      if (options.generate !== false) {
        generateScripts = makeGenerateScripts({ provider, root: cwd });
      }
    } catch (e) {
      if (options.aiOnly || !(e instanceof DocevalsError)) throw e;
      if (!options.deterministicOnly || options.generate === true) {
        console.warn(
          `moose-docevals: provider unavailable — ${e.message}. Running deterministic evals only.`,
        );
      }
    }
  }

  return runEvals({
    judge,
    generateScripts,
    config,
    configPath: options.config,
    globs,
    cwd: options.cwd,
    deterministicOnly: options.deterministicOnly,
    aiOnly: options.aiOnly,
    frontmatterCommands: options.frontmatterCommands,
    generate: options.generate,
    failOnReview: options.failOnReview,
    evalNames: options.evalNames,
    suite: options.suite,
    since: options.since,
    baseline: options.baseline,
    writeBaseline: options.writeBaseline,
    toolVersion: options.toolVersion,
    judgeOptions,
    ...engineOverrides,
  });
}

export { render };
