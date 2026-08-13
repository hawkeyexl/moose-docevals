/**
 * Judge cache key composition. The cache itself is the inference library's
 * `JsonCache`; what stays here is what only moose-docevals can decide — what
 * invalidates an entry: provider, model, prompt version, run count,
 * temperature, the page body, and the resolved eval.
 */
import { buildCacheKey, sha256 } from "@hawkeyexl/inference";
import type { ResolvedEval } from "../core/resolve.js";
import { PROMPT_VERSION } from "./prompt.js";

export { sha256 };

export function cacheKey(
  provider: string,
  model: string,
  runs: number,
  temperature: number,
  body: string,
  ev: ResolvedEval,
): string {
  const evalFingerprint = JSON.stringify({
    assertion: ev.assertion,
    evidence: ev.evidence,
    examples: ev.examples,
    type: ev.type,
  });
  return buildCacheKey([
    provider,
    model,
    `v${PROMPT_VERSION}`,
    `r${runs}`,
    `t${temperature}`,
    // Pre-hashed: page bodies are large and key parts should stay short.
    sha256(body),
    sha256(evalFingerprint),
  ]);
}
