/**
 * The published frontmatter schema — moose-docevals' implementation of the
 * common vocabulary docmeta proposes as `docmeta:evals:1.0.0-proposal.2`
 * (docmeta proposal 0023), plus the citations vocabulary this repo ships
 * ahead of a docmeta proposal for it (ADR 01045). docmeta publishes the
 * vocabulary; this repo ships a schema for it and implements the graders
 * behind it. Consumers point their validator at the shipped file (or import
 * the object directly).
 *
 *   docmeta validate --schema node_modules/moose-docevals/schemas/frontmatter-1.2.0.json docs/
 *
 * In a moose-docevals config, a `tool:docmeta` eval references it the same way:
 *
 *   options:
 *     schemas: ["node_modules/moose-docevals/schemas/frontmatter-1.2.0.json"]
 *
 * **1.0.0 and 1.1.0 still ship and are still byte-identical.** A schema's
 * bytes are frozen once published, so tracking proposal.2 — which added
 * `weight`, `target`, `runs` and `model` — meant 1.1.0 rather than an edit,
 * and adding `cites` and `cite-commit` meant 1.2.0. Every page valid against
 * an older version is valid against this one; the additions are optional. A
 * consumer that pinned an older version by path or by `$id` keeps resolving
 * it, which is the whole point of not editing it.
 */
import { fileURLToPath } from "node:url";
import schema from "../schemas/frontmatter-1.2.0.json" with { type: "json" };

/** Every schema version this package ships, newest first. */
export const FRONTMATTER_SCHEMA_VERSIONS = ["1.2.0", "1.1.0", "1.0.0"] as const;

/** The current schema object, for validators that accept an inline schema. */
export const frontmatterSchema = schema as Record<string, unknown>;

/** Canonical `$id` of the current published schema. */
export const FRONTMATTER_SCHEMA_ID = frontmatterSchema.$id as string;

/**
 * Absolute path to the shipped schema file, for validators that take a path.
 * Resolves against the installed package, so it works from any working
 * directory.
 */
export function frontmatterSchemaPath(): string {
  return fileURLToPath(
    new URL("../schemas/frontmatter-1.2.0.json", import.meta.url),
  );
}
