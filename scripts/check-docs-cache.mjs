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
 * The reachable set is built with the judge's own code — `cacheKey`,
 * `judgeCacheBody` and `readTarget`, all exported for this — rather than by
 * reproducing the key composition here. An earlier version did reproduce it and
 * silently went wrong the moment the judge began prefixing the chunk budget:
 * every key it computed matched nothing, which reads as "the whole cache is
 * missing" and, under `--prune`, as "every file is an orphan".
 */
import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadConfig,
  discoverPages,
  resolvePages,
  resolveProviderIdentity,
  cacheKey,
  judgeCacheBody,
  readTarget,
} from "../dist/index.js";

const CONFIG = process.env["DOCS_CONFIG"] ?? "docs/moose.config.yaml";
const prune = process.argv.includes("--prune");

const config = loadConfig(CONFIG, process.cwd());
const dir = resolve(process.cwd(), config.judge.cacheDir);
const { provider, model } = resolveProviderIdentity(config);
const plans = resolvePages(discoverPages(config, [], process.cwd()), config);

/** key -> "page :: eval", so a miss can name what is missing. */
const reachable = new Map();
for (const plan of plans) {
  // Skipped pages and skipped evals never reach the judge, so no fixture is
  // ever written for them; counting them reachable reports permanent misses.
  if (plan.skip) continue;
  for (const ev of plan.evals) {
    if (ev.grader !== "ai" || ev.skip) continue;
    // Every input the judge uses, resolved the way the judge resolves it:
    // per-eval provider/model overrides, per-eval `runs`, the chunk budget,
    // and the *selected target* rather than the whole page body.
    const identity = resolveProviderIdentity(config, {
      provider: ev.provider,
      model: ev.model,
    });
    const selected = readTarget(ev.target, plan);
    if (!selected.ok) continue; // the judge errors this eval; it caches nothing
    reachable.set(
      cacheKey(
        identity.provider,
        identity.model,
        ev.runs ?? config.judge.ensembleRuns,
        config.judge.temperature,
        judgeCacheBody(config.judge.chunkChars, selected.text),
        ev,
      ),
      `${plan.page.file} :: ${ev.name}`,
    );
  }
}

const onDisk = readdirSync(dir).filter((f) => f.endsWith(".json"));
const diskKeys = new Set(onDisk.map((f) => f.replace(/\.json$/, "")));
const missing = [...reachable].filter(([k]) => !diskKeys.has(k));

console.log(
  `check-docs-cache: ${reachable.size} judged eval(s), ${onDisk.length} cache file(s), ` +
    `${missing.length} missing (provider=${provider} model=${model})`,
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

// The missing-count guard above cannot catch a reachable set that is *empty*:
// nothing missing, so nothing aborts — and then every file on disk is an orphan
// and `--prune` deletes the entire committed cache. That is the one shape where
// "no key matched" means the resolution broke, not that the fixtures are stale:
// a config that resolves no judged evals while fixtures sit beside it is a
// contradiction, and deleting is the irreversible reading of it.
if (reachable.size === 0 && onDisk.length > 0) {
  console.error(
    `check-docs-cache: no judged evals resolved, but ${onDisk.length} cache ` +
      `file(s) exist. Refusing to treat every one of them as an orphan — this ` +
      `is far more likely a config or resolution problem than a cache that ` +
      `should be emptied. Nothing was deleted.`,
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
