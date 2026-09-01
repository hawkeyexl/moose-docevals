/**
 * Assert the committed docs judge cache can answer every judged eval — and,
 * with `--prune`, delete the entries nothing can reach any more.
 *
 * `verify-docs` replays this cache with no provider reachable, so an
 * *incomplete* cache is the failure that matters. It does not announce itself:
 * a missing entry is a cache miss, a miss reaches for a provider, and with
 * `llama-cpp` that provider constructs successfully even with no model
 * present — so the run fails at inference, records `needs-review`, and
 * `needs-review` is excluded from both `passRate` and `hasFailure`. The job
 * goes green having judged nothing. Worse, the miss first tries to install
 * `node-llama-cpp` and download several gigabytes of weights on a CI runner.
 *
 * Checking the keys directly costs milliseconds and contacts nothing, so the
 * incomplete cache is caught before any of that can start.
 *
 * The reachable set is recomputed the way the judge computes it. That
 * replication is the risk, so it is guarded: every computed key must already
 * exist on disk before a prune deletes anything. A wrong replication finds
 * zero matches and aborts instead of removing live fixtures.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCacheKey, sha256 } from "@hawkeyexl/inference";
import {
  loadConfig,
  discoverPages,
  resolvePages,
  resolveProviderIdentity,
} from "../dist/index.js";

const CONFIG = process.env["DOCS_CONFIG"] ?? "docs/moose.config.yaml";
const prune = process.argv.includes("--prune");

/**
 * Mirrors `cacheKey` in src/judge/cache.ts, which is not exported. Read
 * PROMPT_VERSION from source rather than hard-coding it, so a bump cannot
 * silently make every key here wrong in the same direction.
 */
const promptSrc = readFileSync("src/judge/prompt.ts", "utf8");
const pv = /PROMPT_VERSION\s*=\s*"?([^";\s]+)"?/.exec(promptSrc)?.[1];
if (!pv) {
  console.error("check-docs-cache: could not read PROMPT_VERSION from src/judge/prompt.ts");
  process.exit(2);
}

function keyFor(provider, model, runs, temperature, body, ev) {
  const fingerprint = JSON.stringify({
    assertion: ev.assertion,
    evidence: ev.evidence,
    examples: ev.examples,
    type: ev.type,
  });
  return buildCacheKey([
    provider,
    model,
    `v${pv}`,
    `r${runs}`,
    `t${temperature}`,
    sha256(body),
    sha256(fingerprint),
  ]);
}

const config = loadConfig(CONFIG, process.cwd());
const dir = resolve(process.cwd(), config.judge.cacheDir);
const { provider, model } = resolveProviderIdentity(config);
const plans = resolvePages(discoverPages(config, [], process.cwd()), config);

/** key -> "page :: eval", so a miss can name what is missing. */
const reachable = new Map();
for (const plan of plans) {
  for (const ev of plan.evals) {
    if (ev.grader !== "ai") continue;
    reachable.set(
      keyFor(provider, model, config.judge.ensembleRuns, config.judge.temperature, plan.page.body, ev),
      `${plan.page.file} :: ${ev.name}`,
    );
  }
}

const onDisk = readdirSync(dir).filter((f) => f.endsWith(".json"));
const diskKeys = new Set(onDisk.map((f) => f.replace(/\.json$/, "")));
const missing = [...reachable].filter(([k]) => !diskKeys.has(k));

console.log(
  `check-docs-cache: ${reachable.size} judged eval(s), ${onDisk.length} cache file(s), ` +
    `${missing.length} missing (provider=${provider} model=${model} v${pv})`,
);

if (missing.length > 0) {
  console.error(
    `\ncheck-docs-cache: the committed cache cannot answer ${missing.length} judged eval(s):`,
  );
  for (const [, label] of missing) console.error(`  ${label}`);
  console.error(
    `\nEach of these would be a cache miss. In CI that reaches for a provider that is not\n` +
      `there, which does NOT fail the run — the eval lands in needs-review, which is\n` +
      `excluded from the pass rate. Run \`npm run docs:refresh-cache\` and commit the result.`,
  );
  process.exit(1);
}

const orphans = onDisk.filter((f) => !reachable.has(f.replace(/\.json$/, "")));
if (orphans.length === 0) process.exit(0);

if (!prune) {
  console.log(
    `check-docs-cache: ${orphans.length} orphaned entr${orphans.length === 1 ? "y" : "ies"} ` +
      `(harmless, never read). Run with --prune to remove.`,
  );
  process.exit(0);
}
for (const o of orphans) {
  console.log(`  pruned ${o}`);
  rmSync(join(dir, o));
}
