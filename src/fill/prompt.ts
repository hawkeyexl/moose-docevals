/**
 * Fill prompt: asks the provider to propose ai-graded evals for a page, each
 * with a self-reported 0-1 confidence. Proposals are gated by the confidence
 * threshold downstream; the prompt itself only demands honesty and restraint.
 * `command` evals are deliberately out of scope — a command eval without a
 * command would seed script generation (and eventual execution) on the next
 * run, and determinism already flows through promote/generate.
 */
import { Ajv2020 } from "ajv/dist/2020.js";

/** Part of the cache key: bump whenever the prompt or schema changes. */
export const FILL_PROMPT_VERSION = 2;

export const FILL_SYSTEM_PROMPT = [
  "You propose evals for documentation pages. An eval is a plain-language",
  "assertion about a page that an LLM judge will grade against the page",
  "content on every future run — a durable quality contract, not a one-off",
  "observation.",
  "",
  "Rules for every proposal:",
  "- Assert durable, page-specific properties a maintainer would want",
  "  guarded (structure, coverage, accuracy anchors) — never incidental",
  "  phrasing, styling, or facts likely to change by design.",
  "- The assertion must be judgeable from the page content alone.",
  "- Ids are short kebab-case identifiers, unique on the page.",
  "- Provide examples.pass and examples.fail: one sentence each describing",
  "  a state of the page that satisfies or violates the assertion.",
  "- Report an honest confidence between 0 and 1 that the assertion is",
  "  correct, checkable, and worth guarding. Do not inflate it.",
  "- Do not duplicate or rephrase the page's existing evals.",
  "- Propose at most the requested number, fewer when the page offers",
  "  little worth guarding, and nothing at all when nothing qualifies.",
].join("\n");

export const MAX_BODY_CHARS = 6000;

export const PROPOSAL_SCHEMA = {
  type: "object",
  required: ["evals"],
  properties: {
    evals: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "assertion", "confidence", "examples"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          assertion: { type: "string", minLength: 1 },
          type: { enum: ["capability", "regression"] },
          evidence: { type: "string" },
          examples: {
            type: "object",
            required: ["pass", "fail"],
            properties: {
              pass: { type: "string" },
              fail: { type: "string" },
            },
            additionalProperties: false,
          },
          severity: { enum: ["error", "warning", "info"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

const ajv = new Ajv2020({ allErrors: true });
const validateProposal = ajv.compile(
  PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
);

/** True when `value` matches PROPOSAL_SCHEMA. */
export function isValidProposal(value: unknown): boolean {
  return validateProposal(value);
}

export interface ExistingEval {
  id: string;
  assertion?: string;
}

export function buildFillUser(
  file: string,
  body: string,
  existing: ExistingEval[],
  maxEvals: number,
): string {
  const sample =
    body.length > MAX_BODY_CHARS
      ? `${body.slice(0, MAX_BODY_CHARS)}\n…(truncated)`
      : body;
  const existingLines =
    existing.length === 0
      ? ["(none)"]
      : existing.map((e) =>
          e.assertion ? `- ${e.id}: ${e.assertion}` : `- ${e.id}`,
        );
  return [
    "# Page path",
    file,
    "",
    "# Existing evals (do not duplicate these)",
    ...existingLines,
    "",
    "# Maximum proposals",
    String(maxEvals),
    "",
    "# Page content",
    "",
    sample,
  ].join("\n");
}
