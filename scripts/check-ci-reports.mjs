/**
 * Assert that the SARIF and JUnit reports the built CLI emits are actually
 * consumable.
 *
 * Both formats fail *silently* in the place they are meant to help: a SARIF log
 * with a non-repo-relative URI uploads successfully and annotates nothing, and
 * invalid JUnit XML makes a CI system report "no tests found" rather than the
 * failure it was handed. Neither shows up as a red step on its own, so the only
 * way to know is to read the bytes.
 *
 * This lives in a file rather than inline in the workflow for two reasons: it
 * can be run locally against a real report, and it does not have to survive
 * being escaped through YAML and a shell. An earlier inline version shelled out
 * to `python3`, which is not reliably on PATH under Git Bash on the
 * windows-latest leg of the matrix.
 *
 * Usage:
 *   node scripts/check-ci-reports.mjs <report.sarif> <report.junit.xml>
 * Exit 0 = both reports are consumable, 1 = a problem, 2 = setup error.
 */
import { readFileSync, existsSync } from "node:fs";

/**
 * Characters XML 1.0 forbids outright - not even as character references.
 *
 * Built from code points rather than written as a regex literal on purpose.
 * The literal form is a run of invisible control characters in the source,
 * and everything between here and the file - editors, formatters, the shell
 * that generated an earlier draft of this script - gets a chance to eat or
 * mangle them. Legal white space (tab, newline, carriage return) is excluded.
 */
const FORBIDDEN_CODE_POINTS = [
  ...span(0x00, 0x08),
  0x0b,
  0x0c,
  ...span(0x0e, 0x1f),
  ...span(0x7f, 0x9f),
];

function span(from, to) {
  return Array.from({ length: to - from + 1 }, (_, n) => from + n);
}

const ILLEGAL_XML = new RegExp(
  `[${FORBIDDEN_CODE_POINTS.map((c) => String.fromCodePoint(c)).join("")}]`,
);

const [sarifPath, junitPath] = process.argv.slice(2);
if (!sarifPath || !junitPath) {
  console.error(
    "check-ci-reports: usage: node scripts/check-ci-reports.mjs <sarif> <junit>",
  );
  process.exit(2);
}
for (const p of [sarifPath, junitPath]) {
  if (!existsSync(p)) {
    console.error(`check-ci-reports: ${p} was not written.`);
    process.exit(2);
  }
}

/** A byte-order mark a shell redirect may have left at the head of a file. */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Read a file, tolerating a BOM the shell redirect may have left. */
function read(path) {
  return readFileSync(path, "utf8").replace(BOM, "");
}

const problems = [];

// --- SARIF ---------------------------------------------------------------
try {
  const log = JSON.parse(read(sarifPath));
  if (log.version !== "2.1.0") {
    problems.push(`SARIF version is ${String(log.version)}, expected 2.1.0`);
  }
  const run = log.runs?.[0];
  if (!run) {
    problems.push("SARIF log carried no runs");
  } else if (!run.results?.length) {
    // The fixture corpus always fails at least one eval, so an empty result
    // set means the reporter dropped findings rather than that all is well.
    problems.push("SARIF log carried no results");
  } else {
    const declared = new Set((run.tool?.driver?.rules ?? []).map((r) => r.id));
    for (const result of run.results) {
      if (!declared.has(result.ruleId)) {
        problems.push(`SARIF result cites undeclared rule ${result.ruleId}`);
      }
      const uri =
        result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "";
      // An absolute or backslashed URI uploads fine and matches no file.
      if (uri.includes("\\") || /^([A-Za-z]:|\/)/.test(uri)) {
        problems.push(`SARIF uri is not repo-relative: ${uri}`);
      }
    }
    if (problems.length === 0) {
      console.log(`SARIF ok: ${run.results.length} result(s)`);
    }
  }
} catch (e) {
  problems.push(`SARIF did not parse as JSON — ${e.message}`);
}

// --- JUnit ---------------------------------------------------------------
const xml = read(junitPath);
const illegal = ILLEGAL_XML.exec(xml);
if (illegal) {
  // One ANSI escape from a colour-emitting tool is enough. Finding messages
  // carry raw stderr, so this is the likeliest way the report becomes garbage.
  const code = illegal[0].codePointAt(0).toString(16).padStart(4, "0");
  problems.push(
    `JUnit report contains U+${code.toUpperCase()}, which XML 1.0 forbids — ` +
      `no CI system will parse it`,
  );
}
if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
  problems.push("JUnit report has no XML declaration");
}
const cases = xml.match(/<testcase[ />]/g) ?? [];
if (cases.length === 0) problems.push("JUnit report carried no testcases");

// Every opened element is closed. Not a parser, but it catches the shapes a
// broken reporter actually produces — an unterminated <failure> body, a
// testsuite left open by an early return.
for (const tag of ["testsuites", "testsuite", "testcase", "failure", "error"]) {
  const open = (xml.match(new RegExp(`<${tag}[ />]`, "g")) ?? []).length;
  const selfClosing = (
    xml.match(new RegExp(`<${tag}[^>]*/>`, "g")) ?? []
  ).length;
  const close = (xml.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
  if (open - selfClosing !== close) {
    problems.push(
      `JUnit <${tag}>: ${open - selfClosing} opened, ${close} closed`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    "check-ci-reports: the CI reports are not consumable.\n" +
      problems.map((p) => `  ${p}`).join("\n"),
  );
  process.exit(1);
}

console.log(`JUnit ok: ${cases.length} testcase(s)`);
