/**
 * `moose-docevals generate` — generate check scripts for command-graded evals that
 * have a plain-language assertion but no command yet (or whose assertion
 * changed since generation), without running any evals.
 */
import { loadConfig } from "../core/config.js";
import { discoverPages } from "../core/discover.js";
import { resolvePages } from "../core/resolve.js";
import { makeGenerateScripts } from "../graders/scriptgen.js";
import { makeProvider } from "../judge/provider.js";
import { sha256 } from "../judge/cache.js";
import type { GraderTarget } from "../graders/types.js";

export interface GenerateOptions {
  config?: string;
  provider?: string;
  model?: string;
  cwd?: string;
}

export interface GenerateRun {
  generatedPaths: string[];
  targets: number;
}

export async function runGenerate(
  globs: string[],
  options: GenerateOptions = {},
): Promise<GenerateRun> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(options.config, cwd);
  const pages = discoverPages(config, globs, cwd);
  const plans = resolvePages(pages, config);

  const targets: GraderTarget[] = [];
  for (const plan of plans) {
    if (plan.skip || plan.problems.some((p) => p.level === "error")) continue;
    for (const ev of plan.evals) {
      if (ev.skip || ev.grader !== "command") continue;
      const missing = !ev.command;
      const stale =
        ev.command != null &&
        ev.generated != null &&
        ev.assertion != null &&
        ev.generated.assertionHash !== sha256(ev.assertion);
      if ((missing || stale) && ev.assertion) {
        targets.push({ plan, eval: ev });
      }
    }
  }
  if (targets.length === 0) return { generatedPaths: [], targets: 0 };

  const provider = makeProvider(config, {
    provider: options.provider,
    model: options.model,
  });
  const generate = makeGenerateScripts({ provider, root: cwd });
  const { generatedPaths } = await generate(targets, config, {});
  return { generatedPaths, targets: targets.length };
}
