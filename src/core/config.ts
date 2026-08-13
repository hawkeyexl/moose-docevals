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

export type ProviderName = "anthropic" | "openai" | "claude-cli";

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface EvalDef {
  assertion?: string;
  type?: EvalType;
  grader?: string;
  evidence?: string;
  examples?: { pass?: string; fail?: string };
  command?: string[];
  successExitCodes?: number[];
  timeoutMs?: number;
  generated?: { assertionHash: string };
  options?: Record<string, unknown>;
  severity?: Severity;
  severityMap?: Record<string, Severity>;
}

export interface SuiteDef {
  targetPassRate: number;
  evals: string[];
}

export interface DocevalsConfig {
  version: 1;
  files: { include: string[]; exclude: string[] };
  defaults: { suite: string | null; failFast: boolean; concurrency: number };
  provider: {
    default: ProviderName;
    anthropic: { model: string; apiKeyEnv: string; pricing?: Pricing };
    openai: {
      baseUrl: string;
      model: string;
      apiKeyEnv: string;
      pricing?: Pricing;
    };
    "claude-cli": { model: string; command: string };
  };
  judge: {
    ensembleRuns: number;
    temperature: number;
    zones: { autoPass: number; autoFail: number };
    falsePositiveAlert: number;
    cacheDir: string;
    maxCostUsd: number | null;
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
    maxCostUsd: number | null;
  };
  evals: Record<string, EvalDef>;
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

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const validateConfig = ajv.compile(configSchema);

interface RawSuiteDef {
  targetPassRate?: number;
  evals?: string[];
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
  if (!validateConfig(raw)) {
    const details = (validateConfig.errors ?? [])
      .map((e) => `  ${e.instancePath || "/"}: ${e.message}`)
      .join("\n");
    throw new DocevalsError(`Invalid config in ${configPath}:\n${details}`);
  }

  // Sibling tools own the other root keys; this reads only its own namespace.
  // A file that configures no docevals at all leaves every default in place.
  const r = ((raw as Record<string, any>)[NAMESPACE] ?? {}) as Record<string, any>;
  const abs = resolve(configPath);
  const dir = dirname(abs);

  const suites: Record<string, SuiteDef> = {};
  for (const [name, def] of Object.entries(
    (r.suites ?? {}) as Record<string, RawSuiteDef>,
  )) {
    suites[name] = {
      targetPassRate: def.targetPassRate ?? 1.0,
      evals: def.evals ?? [],
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
      failFast: r.defaults?.failFast ?? false,
      concurrency: r.defaults?.concurrency ?? 4,
    },
    provider: {
      default: r.provider?.default ?? "anthropic",
      anthropic: {
        model: r.provider?.anthropic?.model ?? "claude-sonnet-4-5",
        apiKeyEnv: r.provider?.anthropic?.apiKeyEnv ?? "ANTHROPIC_API_KEY",
        pricing: r.provider?.anthropic?.pricing,
      },
      openai: {
        baseUrl: r.provider?.openai?.baseUrl ?? "https://api.openai.com/v1",
        model: r.provider?.openai?.model ?? "gpt-4o-mini",
        apiKeyEnv: r.provider?.openai?.apiKeyEnv ?? "OPENAI_API_KEY",
        pricing: r.provider?.openai?.pricing,
      },
      "claude-cli": {
        model: r.provider?.["claude-cli"]?.model ?? "claude-sonnet-4-5",
        command: r.provider?.["claude-cli"]?.command ?? "claude",
      },
    },
    judge: {
      ensembleRuns: r.judge?.ensembleRuns ?? 3,
      temperature: r.judge?.temperature ?? 0,
      zones: {
        autoPass: r.judge?.zones?.autoPass ?? 0.8,
        autoFail: r.judge?.zones?.autoFail ?? 0.8,
      },
      falsePositiveAlert: r.judge?.falsePositiveAlert ?? 0.15,
      cacheDir: r.judge?.cacheDir ?? ".moose-docevals/cache",
      maxCostUsd: r.judge?.maxCostUsd ?? null,
    },
    scripts: {
      dir: r.scripts?.dir ?? "{docDir}/moose-docevals",
      configDir: r.scripts?.configDir ?? "moose-docevals-scripts",
      allowFrontmatterCommands: r.scripts?.allowFrontmatterCommands ?? true,
      timeoutMs: r.scripts?.timeoutMs ?? 30000,
    },
    fill: {
      confidenceThreshold: r.fill?.confidenceThreshold ?? 0.7,
      maxEvalsPerPage: r.fill?.maxEvalsPerPage ?? 3,
      temperature: r.fill?.temperature ?? 0,
      cacheDir: r.fill?.cacheDir ?? ".moose-docevals/cache/fill",
      maxCostUsd: r.fill?.maxCostUsd ?? null,
    },
    evals: (r.evals ?? {}) as Record<string, EvalDef>,
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
  const candidate = resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (existsSync(candidate)) {
    return parseConfig(readFileSync(candidate, "utf8"), candidate);
  }
  // Falling through to defaults here would run with no named evals and no
  // suites — and pass. Name the migration instead of failing silently.
  const legacy = resolve(cwd, LEGACY_CONFIG_FILENAME);
  if (existsSync(legacy)) {
    throw new DocevalsError(
      `Found ${LEGACY_CONFIG_FILENAME} but no ${DEFAULT_CONFIG_FILENAME} in ${cwd}. ` +
        `moose-docevals now reads the shared moose config: rename the file to ` +
        `${DEFAULT_CONFIG_FILENAME} and indent its contents under a top-level ` +
        `"${NAMESPACE}:" key.`,
    );
  }
  return parseConfig("{}", candidate);
}
