import { describe, it, expect } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  FILL_SYSTEM_PROMPT,
  MAX_BODY_CHARS,
  PROPOSAL_SCHEMA,
  buildFillUser,
} from "../../src/fill/prompt.js";

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(PROPOSAL_SCHEMA as Record<string, unknown>);

const GOOD_EVAL = {
  id: "has-overview",
  assertion: "The page opens with an overview.",
  confidence: 0.9,
  examples: { pass: "Overview present.", fail: "No overview." },
};

describe("buildFillUser", () => {
  it("includes the page path, max count, and existing evals", () => {
    const user = buildFillUser(
      "docs/page.mdx",
      "body text",
      [{ id: "existing-check", assertion: "Something holds." }],
      3,
    );
    expect(user).toContain("docs/page.mdx");
    expect(user).toContain("3");
    expect(user).toContain("existing-check");
    expect(user).toContain("Something holds.");
    expect(user).toContain("body text");
  });

  it("says none when the page has no evals", () => {
    const user = buildFillUser("docs/page.mdx", "body", [], 3);
    expect(user).toMatch(/\(none\)/);
  });

  it("truncates the body at MAX_BODY_CHARS", () => {
    const body = "x".repeat(MAX_BODY_CHARS + 100);
    const user = buildFillUser("docs/page.mdx", body, [], 3);
    expect(user).toContain("…(truncated)");
    expect(user).not.toContain("x".repeat(MAX_BODY_CHARS + 1));
  });
});

describe("PROPOSAL_SCHEMA", () => {
  it("accepts a valid proposal", () => {
    expect(validate({ evals: [GOOD_EVAL] })).toBe(true);
    expect(validate({ evals: [] })).toBe(true);
  });

  it("rejects a proposal missing confidence or examples", () => {
    const { confidence: _c, ...noConfidence } = GOOD_EVAL;
    expect(validate({ evals: [noConfidence] })).toBe(false);
    const { examples: _e, ...noExamples } = GOOD_EVAL;
    expect(validate({ evals: [noExamples] })).toBe(false);
  });

  it("rejects bad names, out-of-range confidence, and stray keys", () => {
    expect(validate({ evals: [{ ...GOOD_EVAL, id: "Bad_Name" }] })).toBe(false);
    expect(validate({ evals: [{ ...GOOD_EVAL, confidence: 1.5 }] })).toBe(false);
    expect(validate({ evals: [{ ...GOOD_EVAL, grader: "command" }] })).toBe(false);
  });
});

describe("FILL_SYSTEM_PROMPT", () => {
  it("demands honest confidence and allows proposing nothing", () => {
    expect(FILL_SYSTEM_PROMPT).toMatch(/confidence/i);
    expect(FILL_SYSTEM_PROMPT).toMatch(/nothing/i);
  });
});
