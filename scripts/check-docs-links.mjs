/**
 * Verify every internal link in the built docs site resolves.
 *
 * `moose-docevals run` checks that a page's *commands* are true; nothing checks that
 * its *links* are. With ~1,350 internal links across the content set, a single
 * renamed route silently produces dozens of 404s that no existing gate catches
 * — the site builds fine either way.
 *
 * Run after `npm run build` in docs/. Exits 1 listing every broken target.
 */
import fs from "node:fs";
import path from "node:path";

const DIST = process.env.DOCS_DIST ?? "docs/dist";
/** Must match `base` in docs/astro.config.mjs. */
const BASE = process.env.DOCS_BASE ?? "/moose-docevals";

/** Asset extensions are emitted by the bundler and not worth re-checking. */
const ASSET = /\.(css|js|mjs|svg|png|jpe?g|gif|ico|woff2?|xml|txt|json|webmanifest)$/;

if (!fs.existsSync(DIST)) {
  console.error(`No built site at ${DIST}. Run \`npm run build\` in docs/ first.`);
  process.exit(2);
}

const pages = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith(".html")) pages.push(p);
  }
})(DIST);

/** true / false for internal routes, null for anything not under BASE. */
function resolvesOnDisk(href) {
  let route = href.split("#")[0].split("?")[0];
  // Match the base as a path segment, not a string prefix: a link to
  // /moose-docevals-v2/x must not be treated as base-relative and then reported
  // broken.
  if (route !== BASE && !route.startsWith(`${BASE}/`)) return null;
  route = route.slice(BASE.length) || "/";
  return (
    fs.existsSync(path.posix.join(DIST, route, "index.html")) ||
    fs.existsSync(path.posix.join(DIST, route))
  );
}

let checked = 0;
const broken = new Map();

for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");
  for (const match of html.matchAll(/href="(\/[^"]*)"/g)) {
    const href = match[1];
    if (href.startsWith("//")) continue; // protocol-relative external
    if (ASSET.test(href.split("?")[0])) continue;
    const ok = resolvesOnDisk(href);
    if (ok === null) continue;
    checked++;
    if (!ok) {
      const from = page.replace(`${DIST}/`, "");
      if (!broken.has(href)) broken.set(href, new Set());
      broken.get(href).add(from);
    }
  }
}

console.log(`Checked ${checked} internal link(s) across ${pages.length} built page(s).`);

if (broken.size === 0) {
  console.log("No broken internal links.");
  process.exit(0);
}

console.error(`\n${broken.size} broken link target(s):`);
for (const [href, sources] of broken) {
  const from = [...sources];
  const shown = from.slice(0, 5).join(", ");
  const more = from.length > 5 ? ` (+${from.length - 5} more)` : "";
  console.error(`  ${href}`);
  console.error(`    linked from: ${shown}${more}`);
}
process.exit(1);
