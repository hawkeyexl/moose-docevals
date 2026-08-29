/**
 * Keep `docs/public/schemas/**` byte-identical to `schemas/**`.
 *
 * Why this exists: `schemas/frontmatter-1.0.0.json` declares a `$id` of
 * `https://hawkeyexl.github.io/moose-docevals/schemas/frontmatter-1.0.0.json`,
 * and the docs invite consumers to point `$schema`, a `tool:docmeta` eval, or
 * any JSON Schema validator at that URL. For a long time nothing served it —
 * the schema lived only in `schemas/`, the site had no `public/` directory, and
 * every test passed against a 404. The people taking that offer are not
 * necessarily running moose-docevals at all, so nobody upstream could tell us.
 *
 * Astro serves `docs/public/<path>` at `<base>/<path>`, so a copy there is what
 * makes the `$id` resolve. The copies are committed rather than generated at
 * build time: a published schema is an artifact, and an artifact that only
 * exists inside a build is one nobody reviews.
 *
 * Usage:
 *   node scripts/sync-published-schemas.mjs            # write the copies
 *   node scripts/sync-published-schemas.mjs --check    # fail if they differ
 * Exit 0 = in sync (or written), 1 = drift under --check, 2 = setup error.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "schemas");
const PUBLISHED = path.join(ROOT, "docs", "public", "schemas");

const check = process.argv.includes("--check");

if (!existsSync(SOURCE)) {
  console.error(`sync-published-schemas: no ${SOURCE} to publish from.`);
  process.exit(2);
}

const shipped = readdirSync(SOURCE).filter((f) => f.endsWith(".json"));
if (shipped.length === 0) {
  console.error(`sync-published-schemas: ${SOURCE} holds no schemas.`);
  process.exit(2);
}

const problems = [];

for (const name of shipped) {
  const from = path.join(SOURCE, name);
  const to = path.join(PUBLISHED, name);
  const source = readFileSync(from);
  const served = existsSync(to) ? readFileSync(to) : undefined;
  if (served !== undefined && served.equals(source)) continue;

  if (check) {
    problems.push(
      served === undefined
        ? `  ${name}: not published — its $id URL would 404`
        : `  ${name}: published copy differs from schemas/${name}`,
    );
    continue;
  }
  mkdirSync(PUBLISHED, { recursive: true });
  writeFileSync(to, source);
  console.log(`published ${name}`);
}

// A retired version left behind under public/ keeps resolving forever, which
// is worse than a 404: it answers with a contract the package no longer ships.
if (existsSync(PUBLISHED)) {
  for (const name of readdirSync(PUBLISHED)) {
    if (shipped.includes(name)) continue;
    if (check) {
      problems.push(`  ${name}: published but not shipped in schemas/`);
      continue;
    }
    rmSync(path.join(PUBLISHED, name));
    console.log(`removed stale ${name}`);
  }
}

if (problems.length > 0) {
  console.error(
    "sync-published-schemas: docs/public/schemas is out of sync with schemas/.\n" +
      problems.join("\n") +
      "\n\nRun `npm run schemas:sync` and commit the result.",
  );
  process.exit(1);
}

if (check) console.log("sync-published-schemas: in sync.");
