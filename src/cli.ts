/** moose-docevals CLI entry point. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { DocevalsError } from "./types.js";
import { runList, renderList } from "./commands/list.js";
import { runRun } from "./commands/run.js";
import { runGenerate } from "./commands/generate.js";
import { runFill, renderFill } from "./commands/fill.js";
import { runPromote } from "./commands/promote.js";
import { listReviews, renderReviews, runReview } from "./commands/review.js";
import { runCalibrate, renderCalibration } from "./commands/calibrate.js";
import { runInit } from "./commands/init.js";
import {
  render,
  parseFormat,
  REPORT_FORMATS,
  SUMMARY_FORMATS,
  type ReportFormat,
  type SummaryFormat,
} from "./reporters/index.js";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string };

const program = new Command();

program
  .name("moose-docevals")
  .description(
    "Deterministic and LLM-as-judge evals for documentation pages, driven by frontmatter.",
  )
  .version(pkg.version);

function fail(e: unknown): never {
  if (e instanceof DocevalsError) {
    console.error(pc.red(`moose-docevals: ${e.message}`));
    process.exit(2);
  }
  throw e;
}

function parseIntArg(name: string) {
  return (value: string): number => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 1) {
      fail(new DocevalsError(`${name} must be a positive integer, got "${value}"`));
    }
    return n;
  };
}

function parseFloatArg(name: string) {
  return (value: string): number => {
    const n = Number.parseFloat(value);
    if (Number.isNaN(n) || n < 0) {
      fail(new DocevalsError(`${name} must be a non-negative number, got "${value}"`));
    }
    return n;
  };
}

/**
 * Commander argument parser for `-f/--format` (ADR 01007). Routes through
 * `fail()` for the same reason the numeric parsers do: commander only special-
 * cases InvalidArgumentError, so any other exception escapes `program.parse()`
 * uncaught — a stack trace and exit 1, when a bad flag owes exit 2.
 */
function parseFormatArg<T extends string>(name: string, allowed: readonly T[]) {
  return (value: string): T => {
    try {
      return parseFormat(value, allowed, name);
    } catch (e) {
      fail(e);
    }
  };
}

program
  .command("list")
  .description("Show the resolved eval plan per page without running anything")
  .argument("[globs...]", "File globs (default: config files.include)")
  .option("-c, --config <path>", "Path to moose.config.yaml")
  .option(
    "-f, --format <format>",
    "Output format: human | json",
    parseFormatArg("--format", SUMMARY_FORMATS),
    "human" as SummaryFormat,
  )
  .action((globs: string[], opts: { config?: string; format: SummaryFormat }) => {
    try {
      const run = runList(globs, {
        config: opts.config,
        format: opts.format,
      });
      console.log(renderList(run, opts.format));
      process.exitCode = run.exitCode;
    } catch (e) {
      fail(e);
    }
  });

program
  .command("run")
  .description("Run evals against documentation pages")
  .argument("[globs...]", "File globs (default: config files.include)")
  .option("-c, --config <path>", "Path to moose.config.yaml")
  .option(
    "-f, --format <format>",
    "Output format: human | json | markdown | github",
    parseFormatArg("--format", REPORT_FORMATS),
    "human" as ReportFormat,
  )
  .option("--deterministic-only", "Run only command/tool graders, skip the AI judge")
  .option("--ai-only", "Run only AI-judged evals, skip deterministic graders")
  .option("--no-frontmatter-commands", "Skip command evals defined in page frontmatter")
  .option("--no-generate", "Do not generate scripts for command evals missing a command")
  .option("--no-cache", "Bypass the judge response cache")
  .option("--fail-on-review", "Exit 1 when any eval lands in the human-review zone")
  .option("--provider <name>", "Judge provider: anthropic | openai | claude-cli")
  .option("--model <model>", "Judge model override")
  .option("--runs <n>", "Ensemble runs per eval", parseIntArg("--runs"))
  .option("--max-cost <usd>", "Abort judging past this cost", parseFloatArg("--max-cost"))
  .action(async (globs: string[], opts: Record<string, unknown>) => {
    try {
      const report = await runRun(globs, {
        config: opts.config as string | undefined,
        // parseFormatArg validated this at parse time; the cast only re-narrows
        // from the `unknown` that the Record-typed options bag erases it to.
        format: opts.format as ReportFormat,
        deterministicOnly: opts.deterministicOnly as boolean | undefined,
        aiOnly: opts.aiOnly as boolean | undefined,
        frontmatterCommands: opts.frontmatterCommands as boolean | undefined,
        generate: opts.generate as boolean | undefined,
        cache: opts.cache as boolean | undefined,
        failOnReview: opts.failOnReview as boolean | undefined,
        provider: opts.provider as string | undefined,
        model: opts.model as string | undefined,
        runs: opts.runs as number | undefined,
        maxCost: opts.maxCost as number | undefined,
      });
      console.log(render(report, opts.format as ReportFormat));
      process.exitCode = report.exitCode;
    } catch (e) {
      fail(e);
    }
  });

program
  .command("generate")
  .description(
    "Generate check scripts for command evals with a plain-language assertion but no command",
  )
  .argument("[globs...]", "File globs (default: config files.include)")
  .option("-c, --config <path>", "Path to moose.config.yaml")
  .option("--provider <name>", "Provider: anthropic | openai | claude-cli")
  .option("--model <model>", "Model override")
  .action(
    async (
      globs: string[],
      opts: { config?: string; provider?: string; model?: string },
    ) => {
      try {
        const result = await runGenerate(globs, opts);
        if (result.targets === 0) {
          console.log("Nothing to generate — every command eval has a command.");
          return;
        }
        console.log(
          `Generated ${result.generatedPaths.length}/${result.targets} check script(s):`,
        );
        for (const p of result.generatedPaths) console.log(`  ${p}`);
        if (result.generatedPaths.length < result.targets) {
          process.exitCode = 1;
        }
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("fill")
  .description(
    "Propose frontmatter evals for pages with an LLM; writes proposals at or above the confidence threshold",
  )
  .argument("[globs...]", "File globs (default: config files.include)")
  .option("-c, --config <path>", "Path to moose.config.yaml")
  .option(
    "-f, --format <format>",
    "Output format: human | json",
    parseFormatArg("--format", SUMMARY_FORMATS),
    "human" as SummaryFormat,
  )
  .option("--dry-run", "Report proposals without writing frontmatter")
  .option(
    "--confidence <n>",
    "Minimum confidence to write (0-1, default: config fill.confidenceThreshold)",
    parseFloatArg("--confidence"),
  )
  .option("--max-cost <usd>", "Stop proposing past this cost", parseFloatArg("--max-cost"))
  .option("--no-cache", "Bypass the fill proposal cache")
  .option("--provider <name>", "Provider: anthropic | openai | claude-cli")
  .option("--model <model>", "Model override")
  .action(async (globs: string[], opts: Record<string, unknown>) => {
    try {
      const confidence = opts.confidence as number | undefined;
      if (confidence !== undefined && confidence > 1) {
        fail(new DocevalsError(`--confidence must be between 0 and 1, got ${confidence}`));
      }
      const report = await runFill(globs, {
        config: opts.config as string | undefined,
        dryRun: opts.dryRun as boolean | undefined,
        confidence,
        maxCost: opts.maxCost as number | undefined,
        noCache: opts.cache === false ? true : undefined,
        provider: opts.provider as string | undefined,
        model: opts.model as string | undefined,
      });
      // As in `run`: parseFormatArg validated this at parse time, and the cast
      // only re-narrows from the `unknown` the Record-typed options bag erases
      // it to. renderFill guards itself regardless.
      console.log(renderFill(report, opts.format as SummaryFormat));
      process.exitCode = report.exitCode;
    } catch (e) {
      fail(e);
    }
  });

program
  .command("promote")
  .description(
    "Find ai-graded evals expressible as deterministic checks; --write converts them",
  )
  .argument("[globs...]", "File globs (default: config files.include)")
  .option("-c, --config <path>", "Path to moose.config.yaml")
  .option("--write", "Apply promotions (write scripts and rewrite evals)")
  .option("--provider <name>", "Provider: anthropic | openai | claude-cli")
  .option("--model <model>", "Model override")
  .action(
    async (
      globs: string[],
      opts: { config?: string; write?: boolean; provider?: string; model?: string },
    ) => {
      try {
        const proposals = await runPromote(globs, opts);
        if (proposals.length === 0) {
          console.log("No ai-graded evals found.");
          return;
        }
        for (const p of proposals) {
          const tag = p.promotable
            ? p.applied
              ? pc.green("promoted")
              : pc.cyan("promotable")
            : pc.dim("keep-ai");
          const script = p.scriptPath ? pc.dim(` -> ${p.scriptPath}`) : "";
          console.log(`${tag} ${p.evalName} (${p.source}, ${p.file})${script}`);
          console.log(pc.dim(`  ${p.rationale}`));
        }
        if (!opts.write && proposals.some((p) => p.promotable)) {
          console.log(pc.cyan("\nRe-run with --write to apply promotions."));
        }
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("calibrate")
  .description(
    "Measure judge agreement against a human-verified golden set (.moose-docevals/golden/*.yaml)",
  )
  .option("-c, --config <path>", "Path to moose.config.yaml")
  .option("--golden <dir>", "Golden set directory", ".moose-docevals/golden")
  .option("--provider <name>", "Provider: anthropic | openai | claude-cli")
  .option("--model <model>", "Model override")
  .option("--runs <n>", "Ensemble runs per case", parseIntArg("--runs"))
  .option("--no-cache", "Bypass the judge response cache")
  .action(
    async (opts: {
      config?: string;
      golden?: string;
      provider?: string;
      model?: string;
      runs?: number;
      cache?: boolean;
    }) => {
      try {
        const report = await runCalibrate({
          config: opts.config,
          golden: opts.golden,
          provider: opts.provider,
          model: opts.model,
          runs: opts.runs,
          noCache: opts.cache === false,
        });
        console.log(renderCalibration(report));
        process.exitCode = report.meetsThreshold ? 0 : 1;
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("init")
  .description("Create a starter moose.config.yaml in the current directory")
  .action(() => {
    try {
      console.log(`Created ${runInit()}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("review")
  .description(
    "Record a human verdict for an eval in the human-review zone (or list recorded reviews)",
  )
  .argument("[file]", "Page path")
  .argument("[eval]", "Eval name")
  .argument("[verdict]", "pass | fail")
  .option("--reviewer <name>", "Reviewer name recorded with the verdict")
  .option("--note <text>", "Optional note")
  .action(
    (
      file: string | undefined,
      evalName: string | undefined,
      verdict: string | undefined,
      opts: { reviewer?: string; note?: string },
    ) => {
      try {
        if (!file) {
          console.log(renderReviews(listReviews()));
          return;
        }
        if (!evalName || !verdict) {
          throw new DocevalsError(
            "Usage: moose-docevals review <file> <eval> <pass|fail>",
          );
        }
        const entry = runReview(file, evalName, verdict, opts);
        console.log(
          `Recorded ${entry.verdict} for ${entry.evalName} on ${entry.file}`,
        );
      } catch (e) {
        fail(e);
      }
    },
  );

program.parse();
