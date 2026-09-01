/**
 * The ensemble judge: N independent runs per (page, eval), each a fresh
 * request with no shared context (eval isolation), aggregated by consensus
 * and routed through confidence zones. Persisted human reviews resolve
 * needs-review outcomes for unchanged pages.
 *
 * The ensemble mechanics — retry-once, errored runs counting against
 * consensus, cache replay — live in `@hawkeyexl/inference` (ADR 01002). What
 * stays here is moose-docevals' own orchestration: the bounded-concurrency pool
 * across targets, the turn budget, the self-judgment warning, and human-review
 * resolution.
 */
import {
  JsonCache,
  computeConsensus,
  runEnsemble,
  zoneFor,
  type InferenceProvider,
  type JudgeRun,
} from "@hawkeyexl/inference";
import verdictSchemaJson from "./verdict-schema.json" with { type: "json" };
import type { EvalResult } from "../types.js";
import type { DocevalsConfig } from "../core/config.js";
import type { JudgeFn, JudgeOptions } from "../core/engine.js";
import type { GraderTarget } from "../graders/types.js";
import { findReview, loadReviews } from "../core/reviews.js";
import { cacheKey } from "./cache.js";
import { turnBudgetSkipReason } from "./budget.js";
import { JUDGE_SYSTEM_PROMPT, buildUserContent } from "./prompt.js";
import { readTarget } from "../core/target.js";
import { makeProvider } from "./provider.js";
import type { ResolvedEval } from "../core/resolve.js";
import { resolve as resolvePath } from "node:path";

/**
 * moose-docevals' own verdict wording. Structurally identical to the library's
 * canonical schema, but the field descriptions talk about pages rather than
 * generic subjects — and descriptions are prompt surface that steers the
 * model, so they are worth keeping (the inference library's own ADR 01001,
 * not this repo's).
 */
const verdictSchema = verdictSchemaJson as Record<string, unknown>;

export interface JudgeStageDeps {
  /** Provider for evals that do not override `provider`/`model`. */
  provider: InferenceProvider;
  root: string;
  /**
   * Build a provider for an eval that overrides `provider` or `model`.
   *
   * Injected so the engine's tests can drive per-eval overrides with a mock.
   * When absent, one is built from the resolved config — without it `provider`
   * and `model` would validate, appear in the schema, and do nothing, which is
   * worse than not offering them.
   */
  providerFor?: (ev: ResolvedEval) => InferenceProvider;
}

/** Build the engine's judge stage around a concrete provider. */
export function makeJudge(deps: JudgeStageDeps): JudgeFn {
  return async (
    targets: GraderTarget[],
    config: DocevalsConfig,
    options: JudgeOptions,
  ): Promise<EvalResult[]> => {
    const { provider, root } = deps;

    // CLI > eval > config, the same precedence `runsFor` uses. Providers are
    // memoized on their resolved identity: a corpus where fifty evals name one
    // stronger judge builds it once.
    const overridden = new Map<string, InferenceProvider>();
    const buildProvider =
      deps.providerFor ??
      ((ev: ResolvedEval): InferenceProvider =>
        makeProvider(config, {
          ...options,
          provider: options.provider ?? ev.provider,
          model: options.model ?? ev.model,
        }));
    const providerFor = (ev: ResolvedEval): InferenceProvider => {
      if (ev.provider === undefined && ev.model === undefined) return provider;
      const key = `${ev.provider ?? ""}:${ev.model ?? ""}`;
      let p = overridden.get(key);
      if (p === undefined) {
        p = buildProvider(ev);
        overridden.set(key, p);
      }
      return p;
    };
    // CLI > eval > config. The flag is an explicit operator act ("run cheap
    // right now"), so it outranks a page asking for more agreement; the page
    // outranks the corpus default, which is the point of having it.
    const runsFor = (ev: ResolvedEval): number =>
      options.runs ?? ev.runs ?? config.judge.ensembleRuns;
    const temperature = config.judge.temperature;
    const cache = new JsonCache<JudgeRun[]>(
      resolvePath(root, config.judge.cacheDir),
      options.noCache !== true,
      "moose-docevals",
    );
    const reviews = loadReviews(root);
    const maxTurns = options.maxTurns ?? config.judge.maxTurns;
    let turnsSpent = 0;

    const results: EvalResult[] = [];
    const concurrency = config.defaults.concurrency;
    let index = 0;

    const judgeTarget = async (target: GraderTarget): Promise<EvalResult> => {
      const { plan, eval: ev } = target;
      const start = Date.now();
      const runsPerEval = runsFor(ev);
      const judgeProvider = providerFor(ev);

      // Read what the eval asked to be graded. A target that cannot be served
      // errors here rather than falling back to the page body: a verdict about
      // the wrong bytes is worse than no verdict (ADR 01022).
      const selected = readTarget(ev.target, plan);
      if (!selected.ok) {
        return {
          evalName: ev.name,
          type: ev.type,
          grader: ev.grader,
          file: plan.page.file,
          outcome: "error",
          skipReason: selected.reason,
          durationMs: Date.now() - start,
        };
      }

      const key = cacheKey(
        judgeProvider.provider(),
        judgeProvider.modelName(),
        runsPerEval,
        temperature,
        // The selected bytes, not the page body: two targets on one page are
        // two different questions and must not share a cached verdict.
        selected.text,
        ev,
      );
      const cached = cache.get(key) !== undefined;

      // A cached ensemble makes no inference call, so it never touches the
      // budget — the docs corpus replays committed fixtures under any cap.
      // For an uncached one the turns are claimed *before* dispatching, which
      // is the whole point of counting turns rather than dollars: the claim is
      // synchronous, so two workers cannot both clear an almost-exhausted
      // budget and then both spend. See ADR 01019.
      if (maxTurns != null && !cached) {
        if (turnsSpent + runsPerEval > maxTurns) {
          return {
            evalName: ev.name,
            type: ev.type,
            grader: ev.grader,
            file: plan.page.file,
            outcome: "skipped",
            skipReason: turnBudgetSkipReason(maxTurns),
            durationMs: 0,
          };
        }
        // One turn per ensemble run. A run can make a second provider call
        // when the first response fails schema validation (the inference
        // layer retries once), so this is a floor on calls, not an exact
        // count — the cap is exact in *runs*, which is the unit the ensemble
        // is configured in.
        turnsSpent += runsPerEval;
      }

      const runs = await runEnsemble({
        provider: judgeProvider,
        system: JUDGE_SYSTEM_PROMPT,
        user: buildUserContent(ev, selected.text, selected.label),
        runs: runsPerEval,
        temperature,
        schema: verdictSchema,
        cache,
        cacheKey: key,
        label: "moose-docevals",
      });

      const consensusBase = computeConsensus(runs);
      const zone = zoneFor(consensusBase, config.judge.zones);
      const consensus = { ...consensusBase, zone };

      let outcome: EvalResult["outcome"] =
        zone === "auto-pass" ? "pass" : zone === "auto-fail" ? "fail" : "needs-review";
      let via: EvalResult["via"];
      if (outcome === "needs-review") {
        const review = findReview(reviews, plan.page.file, ev.name, plan.page.body);
        if (review) {
          outcome = review.verdict;
          via = "human-review";
        }
      }

      return {
        evalName: ev.name,
        type: ev.type,
        grader: ev.grader,
        file: plan.page.file,
        outcome,
        consensus,
        via,
        durationMs: Date.now() - start,
      };
    };

    // Simple bounded-concurrency pool across targets; runs within one eval
    // stay sequential (independent requests, no shared context).
    const workers = Array.from(
      { length: Math.min(concurrency, targets.length) },
      async () => {
        while (index < targets.length) {
          const i = index++;
          results[i] = await judgeTarget(targets[i]!);
        }
      },
    );
    await Promise.all(workers);
    return results;
  };
}
