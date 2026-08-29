/**
 * Liveness check for the published schemas.
 *
 * `sync-published-schemas.mjs --check` is the *local* half of this promise: it
 * asserts that `schemas/**` and `docs/public/schemas/**` agree. Every one of
 * its checks passes on a repository whose docs site is 404ing, because none of
 * them leaves the disk — which is exactly the state this repo was in for
 * months, with a `$id` pointing at a URL nothing served.
 *
 * That gap matters here. moose-docevals tells people a version-pinned schema
 * URL never changes, and invites them to depend on it from `$schema` in a
 * document or from a `tool:docmeta` eval's `schemas:`. The people taking that
 * offer are not necessarily running moose-docevals at all, so if a Pages deploy
 * drops the file, changes the base path, or serves something stale, nothing in
 * this repo notices and nobody upstream can tell us — their build just starts
 * failing on a URL we published.
 *
 * So this fetches each `$id` for real and compares what comes back. It is the
 * one check that cannot run on a PR (no network guarantees, and a contributor
 * should not see red for someone else's outage), which is why it runs on a
 * schedule. See `.github/workflows/published-schemas.yml`.
 *
 * Usage:
 *   node scripts/check-published-schemas.mjs [baseUrlOverride]
 * Exit 0 = every $id serves the bytes this repo ships, 1 = drift or an
 * unreachable URL, 2 = setup error.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "schemas");
const TIMEOUT_MS = 20_000;

if (!existsSync(SOURCE)) {
  console.error(`check-published-schemas: no ${SOURCE} to check.`);
  process.exit(2);
}

/**
 * Where to fetch a schema from.
 *
 * The `$id` is the address consumers actually use, so it is the address this
 * checks — not a URL rebuilt from a base and a filename, which would pass
 * happily while the `$id` itself pointed somewhere dead. An override is
 * accepted only to aim the same check at a preview deployment.
 */
function urlFor(schema, name, override) {
  const id = schema.$id;
  if (typeof id !== "string" || !/^https?:\/\//.test(id)) {
    return { error: `${name}: $id is not an http(s) URL (got ${String(id)})` };
  }
  if (!override) return { url: id };
  const parsed = new URL(id);
  return { url: new URL(parsed.pathname, override).toString() };
}

const override = process.argv[2];
const problems = [];
let checked = 0;

for (const name of readdirSync(SOURCE).filter((f) => f.endsWith(".json"))) {
  const raw = readFileSync(path.join(SOURCE, name), "utf8");
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (e) {
    problems.push(`${name}: unreadable JSON — ${e.message}`);
    continue;
  }
  const { url, error } = urlFor(schema, name, override);
  if (error) {
    problems.push(error);
    continue;
  }

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    problems.push(`${name}: ${url} is unreachable — ${e.message}`);
    continue;
  }
  if (!response.ok) {
    // Drain the body even though it is useless. An unconsumed response holds
    // its socket open, and exiting with one open trips a libuv assertion on
    // Windows — the process then dies with 127, which reads as "command not
    // found" rather than "the URL is wrong". A check whose failure mode is
    // unreadable is barely a check.
    await response.body?.cancel();
    problems.push(`${name}: ${url} returned ${response.status}`);
    continue;
  }

  const served = await response.text();
  checked++;
  // Compare the parsed contract, not the bytes: a static host may normalize
  // line endings or trailing whitespace, and failing on that would cry wolf.
  // Anything that changes what the schema *means* still shows up here.
  try {
    if (JSON.stringify(JSON.parse(served)) !== JSON.stringify(schema)) {
      problems.push(`${name}: ${url} serves a different schema than this repo ships`);
    }
  } catch {
    problems.push(`${name}: ${url} did not serve JSON (a 404 page?)`);
  }
}

if (problems.length > 0) {
  console.error(
    "check-published-schemas: published schema URLs are not serving what this repo ships.\n" +
      problems.map((p) => `  ${p}`).join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(`check-published-schemas: ${checked} URL(s) serve the shipped bytes.`);
}
