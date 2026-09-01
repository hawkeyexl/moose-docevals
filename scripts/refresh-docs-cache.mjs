/**
 * Clear the committed docs judge cache, keeping the directory's own README.
 *
 * `docs/.moose-docevals-cache/` is version-controlled on purpose — replaying it
 * is what lets `verify-docs` judge 34 pages with no provider reachable. The
 * README explains that to the next reader, and it is the only file in there
 * that is not a cache entry.
 *
 * This used to be an inline `rmSync(dir, {recursive: true})`, which deleted the
 * README along with the entries every time anyone refreshed the cache. Nothing
 * failed loudly; the file just quietly stopped existing.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/.moose-docevals-cache";
/** Kept because it documents the directory rather than caching anything. */
const KEEP = new Set(["README.md"]);

let entries;
try {
  entries = readdirSync(DIR);
} catch (e) {
  // Nothing to clear is a success: a fresh checkout that has never judged, or
  // a cache dir the run is about to create.
  if (e.code === "ENOENT") process.exit(0);
  throw e;
}

let removed = 0;
for (const entry of entries) {
  if (KEEP.has(entry)) continue;
  rmSync(join(DIR, entry), { recursive: true, force: true });
  removed++;
}

console.log(
  `refresh-docs-cache: cleared ${removed} entr${removed === 1 ? "y" : "ies"} from ${DIR}` +
    `${KEEP.size > 0 ? ` (kept ${[...KEEP].join(", ")})` : ""}`,
);
