/**
 * Judge-provider construction: map moose-docevals' `provider` config section onto
 * the shared inference library's `ProviderSpec`.
 *
 * The providers themselves live in `@hawkeyexl/inference` (ADR 01002). What
 * stays here is the one thing only moose-docevals can decide: which of its own
 * config keys mean what, and which section a `--provider` flag selects.
 */
import {
  makeProvider as makeInferenceProvider,
  resolveProviderIdentity as resolveIdentity,
  type InferenceProvider,
  type ProviderSpec,
} from "@hawkeyexl/inference";
import { DocevalsError } from "../types.js";
import type { DocevalsConfig, ProviderName } from "../core/config.js";
import type { JudgeOptions } from "../core/engine.js";

/** Narrow the config's per-provider sections down to the selected one. */
export function providerSpecFor(
  config: DocevalsConfig,
  options: JudgeOptions = {},
): ProviderSpec {
  const name = (options.provider ?? config.provider.default) as ProviderName;
  switch (name) {
    case "anthropic":
      return {
        provider: "anthropic",
        model: options.model ?? config.provider.anthropic.model,
        apiKeyEnv: config.provider.anthropic.apiKeyEnv,
        // A verdict-shaped tool name steers the model better than a generic
        // one, and it is free to keep.
        anthropic: { toolName: "record_verdict" },
        ...(config.provider.anthropic.pricing
          ? { pricing: config.provider.anthropic.pricing }
          : {}),
      };
    case "openai":
      return {
        provider: "openai",
        model: options.model ?? config.provider.openai.model,
        apiKeyEnv: config.provider.openai.apiKeyEnv,
        baseUrl: config.provider.openai.baseUrl,
        openai: { schemaName: "verdict" },
        ...(config.provider.openai.pricing
          ? { pricing: config.provider.openai.pricing }
          : {}),
      };
    case "claude-cli":
      return {
        provider: "claude-cli",
        model: options.model ?? config.provider["claude-cli"].model,
        command: config.provider["claude-cli"].command,
      };
    default:
      throw new DocevalsError(`Unknown provider "${String(name)}"`);
  }
}

/**
 * Resolve provider identity WITHOUT constructing the provider — cache keys and
 * pricing need it, but a fully-cached run must not require an API key.
 */
export function resolveProviderIdentity(
  config: DocevalsConfig,
  options: JudgeOptions = {},
): { provider: string; model: string } {
  return resolveIdentity(providerSpecFor(config, options));
}

export function makeProvider(
  config: DocevalsConfig,
  options: JudgeOptions = {},
): InferenceProvider {
  try {
    return makeInferenceProvider(providerSpecFor(config, options));
  } catch (e) {
    // The library raises its own InferenceError (missing API key, unknown
    // provider). It must surface as a DocevalsError: `run` degrades to
    // deterministic-only evals on a DocevalsError and rethrows anything else,
    // and cli.ts fail() maps only DocevalsError to exit 2. Letting a foreign
    // error type through turns "no API key configured" from a warning into an
    // unhandled stack trace.
    if (e instanceof DocevalsError) throw e;
    throw new DocevalsError(e instanceof Error ? e.message : String(e));
  }
}
