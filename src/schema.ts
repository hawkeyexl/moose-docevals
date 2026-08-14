/**
 * The published frontmatter schema. moose-docevals owns and ships this schema
 * rather than registering it as a built-in inside a validator — consumers
 * point their validator at the shipped file (or import the object directly).
 *
 *   docmeta validate --schema node_modules/moose-docevals/schemas/frontmatter-0.1.json docs/
 *
 * In a moose-docevals config, a `tool:docmeta` eval references it the same way:
 *
 *   options:
 *     schemas: ["node_modules/moose-docevals/schemas/frontmatter-0.1.json"]
 */
import { fileURLToPath } from "node:url";
import schema from "../schemas/frontmatter-0.1.json" with { type: "json" };

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
    new URL("../schemas/frontmatter-0.1.json", import.meta.url),
  );
}
