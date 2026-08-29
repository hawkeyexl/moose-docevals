/**
 * The published frontmatter schema — moose-docevals' implementation of the
 * common vocabulary docmeta proposes as `docmeta:evals:1.0.0-proposal.1`
 * (docmeta proposal 0023). docmeta publishes the vocabulary; this repo ships a
 * schema for it and implements the graders behind it. Consumers point their
 * validator at the shipped file (or import the object directly).
 *
 *   docmeta validate --schema node_modules/moose-docevals/schemas/frontmatter-1.0.0.json docs/
 *
 * In a moose-docevals config, a `tool:docmeta` eval references it the same way:
 *
 *   options:
 *     schemas: ["node_modules/moose-docevals/schemas/frontmatter-1.0.0.json"]
 */
import { fileURLToPath } from "node:url";
import schema from "../schemas/frontmatter-1.0.0.json" with { type: "json" };

/** The schema object, for validators that accept an inline schema. */
export const frontmatterSchema = schema as Record<string, unknown>;

/** Canonical `$id` of the published schema. */
export const FRONTMATTER_SCHEMA_ID = frontmatterSchema.$id as string;

/**
 * Absolute path to the shipped schema file, for validators that take a path.
 * Resolves against the installed package, so it works from any working
 * directory.
 */
export function frontmatterSchemaPath(): string {
  return fileURLToPath(
    new URL("../schemas/frontmatter-1.0.0.json", import.meta.url),
  );
}
