/**
 * Judge prompt construction. The system prompt sets a binary rubric with an
 * explicit `partial` escape valve; the user content carries the assertion,
 * evidence hint, pass/fail example anchors, and the page body with
 * frontmatter and MDX noise stripped.
 *
 * PROMPT_VERSION is part of every cache key — bump it whenever the prompt
 * changes so stale cached verdicts never survive a prompt revision.
 */
import type { ResolvedEval } from "../core/resolve.js";

export const PROMPT_VERSION = 2;

export const JUDGE_SYSTEM_PROMPT = [
  "You are a meticulous technical documentation judge. You evaluate whether a",
  "documentation page satisfies a specific assertion.",
  "",
  "Rules:",
  "- Judge ONLY the stated assertion against the supplied page content. Do not",
  "  invent requirements the assertion does not state.",
  '- "match" is "pass" only when the assertion is fully satisfied by the page.',
  '- Use "partial" when the page partially satisfies the assertion.',
  '- Use "fail" when the page does not satisfy the assertion.',
  "- Quote the specific page text you relied on in \"observed\". If the page",
  "  lacks relevant content, say so explicitly.",
  "- Be conservative with confidence: reserve values above 0.9 for verdicts a",
  "  careful human reviewer would certainly agree with.",
  "Respond with a JSON object matching the provided schema.",
].join("\n");

/**
 * Strip MDX imports/exports and comments; keep JSX text content and markdown.
 * Fence-aware: lines inside ``` / ~~~ code blocks are page content the judge
 * must see verbatim (a code sample's `import` line is evidence, not MDX noise).
 */
export function cleanBody(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const open = /^(\s*)(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(line);
      if (open && open[2]!.startsWith(fence)) fence = null;
      continue;
    }
    if (open) {
      fence = open[2]!;
      out.push(line);
      continue;
    }
    out.push(
      line
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/^(import|export)\s.*$/, ""),
    );
  }
  // Comments spanning multiple lines are left in place — stray comment text
  // is harmless noise, whereas a post-join strip would reach into fences.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildUserContent(ev: ResolvedEval, body: string): string {
  const parts: string[] = [
    `# Assertion`,
    ev.assertion ?? "",
  ];
  if (ev.evidence) {
    parts.push("", `# Where to look`, ev.evidence);
  }
  if (ev.examples?.pass || ev.examples?.fail) {
    parts.push("", "# Anchors");
    // Anchors widened to lists with the docmeta vocabulary. Interpolating
    // the array would join it with commas and present several distinct
    // examples to the judge as one run-on sentence.
    for (const anchor of ev.examples.pass ?? []) {
      parts.push(`A passing page: ${anchor}`);
    }
    for (const anchor of ev.examples.fail ?? []) {
      parts.push(`A failing page: ${anchor}`);
    }
  }
  parts.push("", "# Page content", "", cleanBody(body));
  return parts.join("\n");
}
