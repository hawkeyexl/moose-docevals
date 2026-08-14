/**
 * Surgical YAML edits. Only the frontmatter block (or the named config eval)
 * is re-serialized via the `yaml` Document API — the page body is carried
 * over byte-for-byte, and untouched YAML keeps its comments and ordering.
 * YAML frontmatter only; TOML/JSON frontmatter cannot be edited in place.
 */
import { parseDocument, Document, YAMLMap, YAMLSeq, isMap, isScalar } from "yaml";
import { DocevalsError } from "../types.js";
import { leadingFrontmatterFormat } from "./discover.js";

export interface EvalUpdates {
  grader?: string;
  command?: string[];
  generated?: { assertionHash: string };
}

interface Split {
  /** The opening fence line including its newline. */
  open: string;
  /** Raw YAML between the fences. */
  block: string;
  /** Everything from the closing fence to EOF, byte-identical. */
  suffix: string;
  /** Line ending style of the file. */
  eol: "\n" | "\r\n";
}

function splitYamlFrontmatter(content: string, path: string): Split {
  const bom = content.charCodeAt(0) === 0xfeff ? content[0]! : "";
  const body = bom ? content.slice(1) : content;
  const openMatch = /^---(\r?\n)/.exec(body);
  if (!openMatch) {
    throw new DocevalsError(
      `${path}: no YAML frontmatter block to edit (only YAML frontmatter is editable)`,
    );
  }
  const eol: "\n" | "\r\n" = openMatch[1] === "\r\n" ? "\r\n" : "\n";
  const lines = body.split(/(?<=\n)/); // keep line endings
  let offset = lines[0]!.length;
  for (let i = 1; i < lines.length; i++) {
    const stripped = lines[i]!.replace(/\r?\n$/, "");
    if (stripped === "---" || stripped === "...") {
      const blockEnd = offset;
      return {
        open: bom + lines[0]!,
        block: body.slice(lines[0]!.length, blockEnd),
        suffix: body.slice(blockEnd),
        eol,
      };
    }
    offset += lines[i]!.length;
  }
  throw new DocevalsError(`${path}: unterminated frontmatter block`);
}

function applyUpdates(
  doc: Document,
  node: YAMLMap,
  updates: EvalUpdates,
): void {
  if (updates.grader !== undefined) node.set("grader", updates.grader);
  if (updates.command !== undefined) {
    const seq = doc.createNode(updates.command) as YAMLSeq;
    seq.flow = true; // ["node", "script.mjs", "{file}"] on one line
    node.set("command", seq);
  }
  if (updates.generated !== undefined) {
    node.set("generated", doc.createNode(updates.generated));
  }
}

/**
 * The `evals` key is either the eval list itself (array form) or an object
 * whose `evals` field holds the list.
 */
function evalSeq(doc: Document): YAMLSeq | undefined {
  const node = doc.get("evals", true);
  if (node instanceof YAMLSeq) return node;
  const nested = doc.getIn(["evals", "evals"]);
  return nested instanceof YAMLSeq ? nested : undefined;
}

function findEvalNode(
  doc: Document,
  evalName: string,
): YAMLMap | undefined {
  const evals = evalSeq(doc);
  if (!evals) return undefined;
  for (const item of evals.items) {
    if (isMap(item)) {
      const name = item.get("name") ?? item.get("use");
      if (name === evalName) return item as YAMLMap;
    }
  }
  return undefined;
}

/**
 * Update an inline eval in a page's YAML frontmatter. Returns the new file
 * content; the body after the closing fence is byte-identical to the input.
 */
export function updatePageEval(
  content: string,
  path: string,
  evalName: string,
  updates: EvalUpdates,
): string {
  const { open, block, suffix, eol } = splitYamlFrontmatter(content, path);
  const doc = parseDocument(block);
  if (doc.errors.length > 0) {
    throw new DocevalsError(
      `${path}: cannot edit frontmatter — ${doc.errors[0]?.message ?? "parse error"}`,
    );
  }
  const node = findEvalNode(doc, evalName);
  if (!node) {
    throw new DocevalsError(
      `${path}: eval "${evalName}" not found in frontmatter`,
    );
  }
  applyUpdates(doc, node, updates);
  let newBlock = doc.toString();
  if (eol === "\r\n") newBlock = newBlock.replace(/(?<!\r)\n/g, "\r\n");
  return open + newBlock + suffix;
}

/** Update a named eval in moose.config.yaml text. */
export function updateConfigEval(
  configText: string,
  configPath: string,
  evalName: string,
  updates: EvalUpdates,
): string {
  const doc = parseDocument(configText);
  if (doc.errors.length > 0) {
    throw new DocevalsError(
      `${configPath}: cannot edit config — ${doc.errors[0]?.message ?? "parse error"}`,
    );
  }
  const node = doc.getIn(["evals", evalName]);
  if (!isMap(node)) {
    throw new DocevalsError(
      `${configPath}: eval "${evalName}" not found in config`,
    );
  }
  applyUpdates(doc, node as YAMLMap, updates);
  return doc.toString();
}

export interface NewEvalEntry {
  name: string;
  assertion: string;
  type?: string;
  grader?: string;
  evidence?: string;
  examples?: { pass: string; fail: string };
  severity?: string;
}

/** Ordered plain object for a new inline eval, with undefined fields dropped. */
function entryObject(entry: NewEvalEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = { name: entry.name, assertion: entry.assertion };
  if (entry.type !== undefined) obj.type = entry.type;
  if (entry.grader !== undefined) obj.grader = entry.grader;
  if (entry.evidence !== undefined) obj.evidence = entry.evidence;
  if (entry.examples !== undefined) obj.examples = entry.examples;
  if (entry.severity !== undefined) obj.severity = entry.severity;
  return obj;
}

function assertNoCollision(seq: YAMLSeq, name: string, path: string): void {
  for (const item of seq.items) {
    const existing = isMap(item)
      ? item.get("name") ?? item.get("use")
      : isScalar(item)
        ? item.value
        : undefined;
    if (existing === name) {
      throw new DocevalsError(
        `${path}: eval "${name}" already exists in frontmatter`,
      );
    }
  }
}

/**
 * Append inline evals to a page's YAML frontmatter, creating the `evals` key
 * — or the frontmatter block itself — when missing. The body stays
 * byte-identical; existing evals are never modified or reordered.
 */
export function appendPageEvals(
  content: string,
  path: string,
  entries: NewEvalEntry[],
): string {
  const format = leadingFrontmatterFormat(content);
  if (format === "toml" || format === "json") {
    // Synthesizing a YAML block here would leave the page with two
    // frontmatter blocks. Only YAML frontmatter can be edited in place.
    throw new DocevalsError(
      `${path}: only YAML frontmatter can be edited (found ${format} frontmatter)`,
    );
  }

  const bom = content.charCodeAt(0) === 0xfeff ? content[0]! : "";
  const stripped = bom ? content.slice(1) : content;
  const eol: "\n" | "\r\n" = stripped.includes("\r\n") ? "\r\n" : "\n";

  if (format === undefined) {
    // No frontmatter: synthesize a block above the untouched body.
    const doc = new Document({ evals: entries.map(entryObject) });
    let block = doc.toString();
    if (eol === "\r\n") block = block.replace(/(?<!\r)\n/g, "\r\n");
    return `${bom}---${eol}${block}---${eol}${stripped}`;
  }

  const { open, block, suffix, eol: blockEol } = splitYamlFrontmatter(content, path);
  const doc = parseDocument(block);
  if (doc.errors.length > 0) {
    throw new DocevalsError(
      `${path}: cannot edit frontmatter — ${doc.errors[0]?.message ?? "parse error"}`,
    );
  }

  let seq = evalSeq(doc);
  if (!seq) {
    seq = doc.createNode([]) as YAMLSeq;
    const node = doc.get("evals", true);
    if (node === undefined) {
      doc.set("evals", seq);
    } else if (isMap(node)) {
      if (node.get("evals", true) !== undefined) {
        throw new DocevalsError(
          `${path}: the evals list in frontmatter is not a sequence`,
        );
      }
      node.set("evals", seq);
    } else {
      throw new DocevalsError(
        `${path}: the evals key in frontmatter is neither a list nor an object`,
      );
    }
  }
  for (const entry of entries) {
    assertNoCollision(seq, entry.name, path);
    seq.add(doc.createNode(entryObject(entry)));
  }
  let newBlock = doc.toString();
  if (blockEol === "\r\n") newBlock = newBlock.replace(/(?<!\r)\n/g, "\r\n");
  return open + newBlock + suffix;
}

/** True when the eval exists as an editable (map) entry in the frontmatter. */
export function hasEditableEval(content: string, evalName: string): boolean {
  try {
    const { block } = splitYamlFrontmatter(content, "");
    const doc = parseDocument(block);
    return findEvalNode(doc, evalName) !== undefined;
  } catch {
    return false;
  }
}

/** Used by promote: check a string-shorthand eval entry (not editable in place). */
export function isScalarEvalEntry(content: string, evalName: string): boolean {
  try {
    const { block } = splitYamlFrontmatter(content, "");
    const doc = parseDocument(block);
    const evals = evalSeq(doc);
    if (!evals) return false;
    return evals.items.some((i) => isScalar(i) && i.value === evalName);
  } catch {
    return false;
  }
}
