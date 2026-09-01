/**
 * Loads and validates `moose.config.yaml`. The file is shared by the moose
 * family of documentation tools: moose-docevals reads its own `docevals:`
 * namespace and leaves every sibling key alone. It carries provider and judge
 * settings plus the central library of named evals and suites that page
 * frontmatter references. Validation is JSON Schema (2020-12) via Ajv; defaults
 * are applied in code afterward so the resolved shape is fully typed.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import configSchema from "./config-schema.json" with { type: "json" };
import { DocevalsError, type EvalType, type Severity } from "../types.js";
// Type-only, so the cycle with target.ts (which needs ResolvedPagePlan) is
// erased at compile time rather than existing at runtime.
import type { EvalTarget } from "./target.js";

export type ProviderName = "anthropic" | "openai" | "claude-cli" | "llama-cpp";

/**
 * One eval definition, as the rest of the codebase sees it.
 *
 * Files — config and page frontmatter alike — spell these keys in kebab-case,
 * because that is the vocabulary docmeta publishes and a field should mean one
 * thing wherever it is written. TypeScript keeps camelCase, because that is
 * what TypeScript reads like. `normalizeEvalDef` is the single boundary
 * between the two; nothing downstream should ever see a kebab key.
 */
export interface EvalDef {
  assertion?: string;
  type?: EvalType;
  grader?: string;
  /** Provider or agent judging an `ai` eval; omit for the config default. */
  provider?: string;
  evidence?: string;
  /** Anchor examples. One or several each — a bare string normalizes to a list. */
  examples?: { pass?: string[]; fail?: string[] };
  command?: string[];
  successExitCodes?: number[];
  timeoutMs?: number;
  /** sha256 of the assertion when the check script was generated. */
  generatedAssertionHash?: string;
  options?: Record<string, unknown>;
  severity?: Severity;
  severityMap?: Record<string, Severity>;
  /** Relative contribution to the suite pass rate. Never changes the outcome. */
  weight?: number;
  /** Which bytes the grader receives. Defaults to the page body. */
  target?: EvalTarget;
  /** Judge model for this eval; a CLI --model still wins. */
  model?: string;
  /** Ensemble runs for this eval; a CLI --runs still wins. */
  runs?: number;
}

/** The file-side spelling of an eval definition. Kebab, exactly as authored. */
export interface RawEvalDef {
  assertion?: string;
  type?: EvalType;
  grader?: string;
  provider?: string;
  evidence?: string;
  examples?: { pass?: string | string[]; fail?: string | string[] };
  command?: string[];
  "success-exit-codes"?: number[];
  "timeout-ms"?: number;
  "generated-assertion-hash"?: string;
  options?: Record<string, unknown>;
  severity?: Severity;
  "severity-map"?: Record<string, Severity>;
  target?: EvalTarget;
  model?: string;
  runs?: number;
  // One word, so kebab and camel are the same string — it still passes through
  // normalizeEvalDef, because that is the only boundary between the two
  // spellings and a field that skips it is a field the next reader has to
  // check for.
  weight?: number;
}

/** One anchor example, or several, as a list. */
function anchorList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Kebab file keys in, camelCase `EvalDef` out. Used for config-defined evals
 * and for page inline evals, so both reach the engine in one shape.
 */
export function normalizeEvalDef(raw: RawEvalDef): EvalDef {
  const examples =
    raw.examples === undefined
      ? undefined
      : {
          ...(anchorList(raw.examples.pass) !== undefined && {
            pass: anchorList(raw.examples.pass),
          }),
          ...(anchorList(raw.examples.fail) !== undefined && {
            fail: anchorList(raw.examples.fail),
          }),
        };
  return {
    assertion: raw.assertion,
    type: raw.type,
    grader: raw.grader,
    provider: raw.provider,
    evidence: raw.evidence,
    examples,
    command: raw.command,
    successExitCodes: raw["success-exit-codes"],
    timeoutMs: raw["timeout-ms"],
    generatedAssertionHash: raw["generated-assertion-hash"],
    options: raw.options,
    severity: raw.severity,
    severityMap: raw["severity-map"],
    weight: raw.weight,
    target: raw.target,
    model: raw.model,
    runs: raw.runs,
  };
}

export interface SuiteDef {
  targetPassRate: number;
  evals: string[];
  /** Criteria scored in this suite, alongside `evals`. */
  criteria: string[];
}

/**
 * Several evals scored as one unit.
 *
 * The grouping lives here rather than in page frontmatter because the page
 * vocabulary is docmeta's and this is our scoring model — a criterion is a
 * statement about how a corpus is graded, not a fact about a page.
 */
export interface CriterionDef {
  evals: string[];
  combine: "all" | "any";
  weight: number;
}

export interface DocevalsConfig {
  version: 1;
  files: { include: string[]; exclude: string[] };
  defaults: { suite: string | null; failFast: boolean; concurrency: number };
  provider: {
    default: ProviderName;
    anthropic: { model: string; apiKeyEnv: string };
    openai: {
      baseUrl: string;
      model: string;
      apiKeyEnv: string;
    };
    "claude-cli": { model: string; command: string };
    /**
     * Local inference. `model` is deliberately a concrete name and never one of
     * the library's selectors ("auto"/"fast"/"balanced"/"quality"): the model is
     * judge cache-key material, and a selector both varies by machine and
     * cannot be resolved synchronously — picking a tier probes GPU memory.
     */
    "llama-cpp": {
      model: string;
      modelsDirectory: string | null;
      thoughtTokens: number;
      maxTokens: number | null;
    };
  };
  /** Findings baseline path, resolved against the config's directory (ADR 01017). */
  baseline: string | null;
  judge: {
    ensembleRuns: number;
    /** Judge-stage parallelism. Falls back to `defaults.concurrency` (ADR 01027). */
    concurrency: number;
    temperature: number;
    zones: { autoPass: number; autoFail: number };
    falsePositiveAlert: number;
    cacheDir: string;
    maxTurns: number | null;
  };
  scripts: {
    dir: string;
    configDir: string;
    allowFrontmatterCommands: boolean;
    timeoutMs: number;
  };
  fill: {
    confidenceThreshold: number;
    maxEvalsPerPage: number;
    temperature: number;
    cacheDir: string;
    maxTurns: number | null;
  };
  evals: Record<string, EvalDef>;
  criteria: Record<string, CriterionDef>;
  suites: Record<string, SuiteDef>;
  /** Absolute path of the loaded config file. */
  configPath: string;
  /** Directory containing the config file; relative paths resolve against it. */
  configDir: string;
}

/** Top-level key moose-docevals owns inside the shared moose config. */
const NAMESPACE = "docevals";

export const DEFAULT_CONFIG_FILENAME = "moose.config.yaml";

/** The pre-rename filename, kept only to raise a migration error. Never read. */
const LEGACY_CONFIG_FILENAME = `${NAMESPACE}.config.yaml`;

/**
 * Root keys that only a pre-rename config has. A moose config namespaces every
 * tool, so finding these at the root means the file was never migrated.
 */
const PRE_RENAME_ROOT_KEYS = [
  "version",
  "files",
  "defaults",
  "provider",
  "judge",
  "scripts",
  "fill",
  "evals",
  "suites",
];

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const validateConfig = ajv.compile(configSchema);

/**
 * The config file's own shape, in its own spelling.
 *
 * Ajv has already validated `raw` against `config-schema.json` by the time this
 * is used, so the optionality here is the schema's, not a guess. Declaring it
 * is what lets `parseConfig` read the file without an `any` — and an `any` here
 * would be the worst place for one, since every default in the tool flows
 * through this function.
 */
interface RawProviderSection {
  model?: string;
  command?: string;
  "base-url"?: string;
  "api-key-env"?: string;
}

interface RawDocevalsConfig {
  version?: 1;
  files?: { include?: string[]; exclude?: string[] };
  defaults?: {
    suite?: string | null;
    "fail-fast"?: boolean;
    concurrency?: number;
  };
  provider?: {
    default?: ProviderName;
    anthropic?: RawProviderSection;
    openai?: RawProviderSection;
    "claude-cli"?: RawProviderSection;
    "llama-cpp"?: {
      model?: string;
      "models-directory"?: string;
      "thought-tokens"?: number;
      "max-tokens"?: number;
    };
  };
  baseline?: string | null;
  judge?: {
    "ensemble-runs"?: number;
    concurrency?: number;
    temperature?: number;
    zones?: { "auto-pass"?: number; "auto-fail"?: number };
    "false-positive-alert"?: number;
    "cache-dir"?: string;
    "max-turns"?: number | null;
  };
  scripts?: {
    dir?: string;
    "config-dir"?: string;
    "allow-frontmatter-commands"?: boolean;
    "timeout-ms"?: number;
  };
  fill?: {
    "confidence-threshold"?: number;
    "max-evals-per-page"?: number;
    temperature?: number;
    "cache-dir"?: string;
    "max-turns"?: number | null;
  };
  evals?: Record<string, RawEvalDef>;
  criteria?: Record<string, RawCriterionDef>;
  suites?: Record<string, RawSuiteDef>;
}

interface RawCriterionDef {
  evals?: string[];
  combine?: "all" | "any";
  weight?: number;
}

interface RawSuiteDef {
  "target-pass-rate"?: number;
  evals?: string[];
  criteria?: string[];
}

/**
 * Object keys whose sub-keys are names chosen by something other than this
 * schema, so a capital letter in them is not a stale spelling:
 *
 *   severity-map — keyed by the *tool's* own severity names
 *   options      — no: grader options are ours, and they kebab with everything
 *                  else (docmeta proposal 0023 leaves this call to each tool)
 */
const FOREIGN_KEY_SPACES = new Set(["severity-map"]);

/** The 0.1 `generated: {assertionHash}` wrapper, as opposed to any other key of that name. */
function isAssertionHashWrapper(value: unknown): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "assertionHash" in value
  );
}

/** Walk `node`, reporting every camelCase key with the kebab it should be. */
function findPreKebabKeys(
  node: unknown,
  path: string,
): { at: string; becomes: string }[] {
  if (node == null || typeof node !== "object" || Array.isArray(node)) return [];
  const found: { at: string; becomes: string }[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/[a-z0-9][A-Z]/.test(key)) {
      found.push({
        at: `${path}.${key}`,
        becomes: key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
      });
    }
    // `generated: {assertionHash}` flattened rather than renamed, so the
    // generic rule above would suggest the wrong thing for the wrapper itself.
    //
    // Matched on shape, not on the name alone: `options` is a grader’s open
    // runtime contract, so a key called `generated` there is legal config and
    // an error naming `generated-assertion-hash` would be advice nobody can
    // follow. Only the 0.1 wrapper — an object carrying `assertionHash` — is
    // the thing this rule is about.
    if (key === "generated" && isAssertionHashWrapper(value)) {
      found.push({ at: `${path}.generated`, becomes: "generated-assertion-hash" });
      continue;
    }
    if (!FOREIGN_KEY_SPACES.has(key)) {
      found.push(...findPreKebabKeys(value, `${path}.${key}`));
    }
  }
  return found;
}

/** Parse and validate config YAML text. `configPath` is used for messages and path resolution. */
export function parseConfig(text: string, configPath: string): DocevalsConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new DocevalsError(
      `Invalid YAML in ${configPath}: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DocevalsError(`Invalid config in ${configPath}: root must be an object`);
  }

  // `--config <path>` reaches here without passing loadConfig's filename check,
  // so a pre-rename file named anything at all would otherwise parse to pure
  // defaults — no evals, no suites, exit 0. Catch it by shape instead.
  if (!(NAMESPACE in raw)) {
    const stray = PRE_RENAME_ROOT_KEYS.filter((k) => k in raw);
    if (stray.length > 0) {
      throw new DocevalsError(
        `Invalid config in ${configPath}: found ${stray.join(", ")} at the root, ` +
          `but no "${NAMESPACE}:" key.\n` +
          `moose.config.yaml is shared across the moose family, so every docevals ` +
          `setting belongs under a top-level "${NAMESPACE}:" key. Indent the file's ` +
          `contents one level and add that key.`,
      );
    }
  }
  // Every config key is kebab-case now. Ajv would reject a leftover camelCase
  // spelling as "must NOT have additional properties", which names the parent
  // object and leaves the reader to guess which key. Name the key and its
  // replacement instead — this is a migration, and a migration that makes you
  // guess is one people work around.
  const preKebab = findPreKebabKeys(
    (raw as Record<string, unknown>)[NAMESPACE],
    NAMESPACE,
  );
  if (preKebab.length > 0) {
    throw new DocevalsError(
      `Invalid config in ${configPath}: camelCase keys are no longer read.\n` +
        preKebab.map((p) => `  ${p.at} -> ${p.becomes}`).join("\n") +
        `\nEvery moose-docevals key is kebab-case, matching the frontmatter vocabulary.`,
    );
  }

  if (!validateConfig(raw)) {
    const details = (validateConfig.errors ?? [])
      .map((e) => {
        // Ajv reports an unknown key against the *parent* object, so the bare
        // message ("must NOT have additional properties") leaves the reader to
        // diff their file against the schema to find which key it meant. Name
        // it, for the same reason findPreKebabKeys above names a camelCase
        // spelling: the common case is a removed key in an unmigrated config
        // -- `judge.max-cost-usd` after ADR 01019, say -- and a migration
        // error that makes you guess is one people work around.
        const extra =
          e.keyword === "additionalProperties"
            ? (e.params as { additionalProperty?: string }).additionalProperty
            : undefined;
        if (extra !== undefined) {
          return `  ${e.instancePath || "/"}: unknown key "${extra}"`;
        }
        return `  ${e.instancePath || "/"}: ${e.message ?? "is invalid"}`;
      })
      .join("\n");
    throw new DocevalsError(`Invalid config in ${configPath}:\n${details}`);
  }

  // Sibling tools own the other root keys; this reads only its own namespace.
  // A file that configures no docevals at all leaves every default in place.
  const r = ((raw as Record<string, unknown>)[NAMESPACE] ??
    {}) as RawDocevalsConfig;
  const abs = resolve(configPath);
  const dir = dirname(abs);

  const suites: Record<string, SuiteDef> = {};
  for (const [name, def] of Object.entries(r.suites ?? {})) {
    suites[name] = {
      targetPassRate: def["target-pass-rate"] ?? 1.0,
      evals: def.evals ?? [],
      criteria: def.criteria ?? [],
    };
  }

  const criteria: Record<string, CriterionDef> = {};
  for (const [name, def] of Object.entries(r.criteria ?? {})) {
    criteria[name] = {
      evals: def.evals ?? [],
      combine: def.combine ?? "all",
      weight: def.weight ?? 1,
    };
  }

  const config: DocevalsConfig = {
    version: 1,
    files: {
      include: r.files?.include ?? ["**/*.{md,mdx}"],
      exclude: r.files?.exclude ?? ["**/node_modules/**"],
    },
    defaults: {
      suite: r.defaults?.suite ?? null,
      failFast: r.defaults?.["fail-fast"] ?? false,
      concurrency: r.defaults?.concurrency ?? 4,
    },
    provider: {
      default: r.provider?.default ?? "anthropic",
      anthropic: {
        model: r.provider?.anthropic?.model ?? "claude-sonnet-4-5",
        apiKeyEnv: r.provider?.anthropic?.["api-key-env"] ?? "ANTHROPIC_API_KEY",
      },
      openai: {
        baseUrl: r.provider?.openai?.["base-url"] ?? "https://api.openai.com/v1",
        model: r.provider?.openai?.model ?? "gpt-4o-mini",
        apiKeyEnv: r.provider?.openai?.["api-key-env"] ?? "OPENAI_API_KEY",
      },
      "claude-cli": {
        model: r.provider?.["claude-cli"]?.model ?? "claude-sonnet-4-5",
        command: r.provider?.["claude-cli"]?.command ?? "claude",
      },
      "llama-cpp": {
        // The library's own default here is the selector "auto". We pin a
        // concrete model instead, for the reason on the DocevalsConfig field.
        model: r.provider?.["llama-cpp"]?.model ?? "qwen3.5-4b",
        modelsDirectory: r.provider?.["llama-cpp"]?.["models-directory"] ?? null,
        // Zero is the library's default and the deterministic choice for
        // judging: a grammar constrains generation from token 0, so an
        // unbudgeted model starts reasoning and gets cut off mid-thought.
        thoughtTokens: r.provider?.["llama-cpp"]?.["thought-tokens"] ?? 0,
        maxTokens: r.provider?.["llama-cpp"]?.["max-tokens"] ?? null,
      },
    },
    baseline: r.baseline ?? null,
    judge: {
      ensembleRuns: r.judge?.["ensemble-runs"] ?? 3,
      // Falls back to the corpus-wide setting, so an unset value behaves
      // exactly as it did before this knob existed. It is separable because
      // the judge's right parallelism is not the deterministic graders': a
      // local in-process model serves one context at a time (ADR 01027).
      concurrency: r.judge?.concurrency ?? r.defaults?.concurrency ?? 4,
      temperature: r.judge?.temperature ?? 0,
      zones: {
        autoPass: r.judge?.zones?.["auto-pass"] ?? 0.8,
        autoFail: r.judge?.zones?.["auto-fail"] ?? 0.8,
      },
      falsePositiveAlert: r.judge?.["false-positive-alert"] ?? 0.15,
      cacheDir: r.judge?.["cache-dir"] ?? ".moose-docevals/cache",
      maxTurns: r.judge?.["max-turns"] ?? null,
    },
    scripts: {
      dir: r.scripts?.dir ?? "{docDir}/moose-docevals",
      configDir: r.scripts?.["config-dir"] ?? "moose-docevals-scripts",
      allowFrontmatterCommands: r.scripts?.["allow-frontmatter-commands"] ?? true,
      timeoutMs: r.scripts?.["timeout-ms"] ?? 30000,
    },
    fill: {
      confidenceThreshold: r.fill?.["confidence-threshold"] ?? 0.7,
      maxEvalsPerPage: r.fill?.["max-evals-per-page"] ?? 3,
      temperature: r.fill?.temperature ?? 0,
      cacheDir: r.fill?.["cache-dir"] ?? ".moose-docevals/cache/fill",
      maxTurns: r.fill?.["max-turns"] ?? null,
    },
    evals: Object.fromEntries(
      Object.entries(r.evals ?? {}).map(([name, def]) => [
        name,
        normalizeEvalDef(def),
      ]),
    ),
    criteria,
    suites,
    configPath: abs,
    configDir: dir,
  };

  // Referential integrity: suites may only reference defined evals.
  for (const [suiteName, suite] of Object.entries(config.suites)) {
    for (const evalName of suite.evals) {
      if (!(evalName in config.evals)) {
        throw new DocevalsError(
          `Invalid config in ${configPath}: suite "${suiteName}" references undefined eval "${evalName}"`,
        );
      }
    }
  }
  for (const [critName, crit] of Object.entries(config.criteria)) {
    for (const evalName of crit.evals) {
      if (!(evalName in config.evals)) {
        throw new DocevalsError(
          `Invalid config in ${configPath}: criterion "${critName}" references undefined eval "${evalName}"`,
        );
      }
    }
  }
  for (const [suiteName, suite] of Object.entries(config.suites)) {
    for (const critName of suite.criteria) {
      if (!(critName in config.criteria)) {
        throw new DocevalsError(
          `Invalid config in ${configPath}: suite "${suiteName}" references undefined criterion "${critName}"`,
        );
      }
    }
  }
  if (config.defaults.suite && !(config.defaults.suite in config.suites)) {
    throw new DocevalsError(
      `Invalid config in ${configPath}: defaults.suite "${config.defaults.suite}" is not a defined suite`,
    );
  }
  return config;
}

/**
 * Load config from an explicit path, or find `moose.config.yaml` in the
 * working directory. With no config file present, built-in defaults apply
 * (no named evals or suites).
 */
export function loadConfig(path?: string, cwd = process.cwd()): DocevalsConfig {
  if (path) {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    if (!existsSync(abs)) {
      throw new DocevalsError(`Config file not found: ${abs}`);
    }
    return parseConfig(readFileSync(abs, "utf8"), abs);
  }
  // Walk up from cwd. A repo keeps one config at its root and people run the
  // CLI from wherever they are — docs/, a package directory, a worktree
  // subdirectory. Looking only in cwd resolved every one of those runs to pure
  // defaults: no named evals, no suites, and a green exit reporting nothing,
  // with the config sitting one directory up.
  for (const dir of ancestorsOf(cwd)) {
    const candidate = resolve(dir, DEFAULT_CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return parseConfig(readFileSync(candidate, "utf8"), candidate);
    }
    // Falling through to defaults here would run with no named evals and no
    // suites — and pass. Name the migration instead of failing silently. This
    // is checked at every level, or a stale config one directory up becomes
    // exactly the silent default-run the cwd-level guard exists to prevent.
    const legacy = resolve(dir, LEGACY_CONFIG_FILENAME);
    if (existsSync(legacy)) {
      throw new DocevalsError(
        `Found ${LEGACY_CONFIG_FILENAME} but no ${DEFAULT_CONFIG_FILENAME} in ${dir}. ` +
          `moose-docevals now reads the shared moose config: rename the file to ` +
          `${DEFAULT_CONFIG_FILENAME} and indent its contents under a top-level ` +
          `"${NAMESPACE}:" key.`,
      );
    }
  }
  return parseConfig("{}", resolve(cwd, DEFAULT_CONFIG_FILENAME));
}

/**
 * `cwd` and each ancestor up to the repository root, nearest first.
 *
 * The walk stops at the directory holding `.git`, and at the filesystem root
 * if there is none. Without that boundary it reaches the home directory and
 * beyond, where it would happily adopt an unrelated project's config — a
 * failure that looks like the tool misreading your settings rather than
 * reading someone else's.
 */
function ancestorsOf(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (existsSync(resolve(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}
