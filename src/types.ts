/**
 * Shared result model for moose-docevals.
 *
 * Vocabulary follows the "Docs as Evals" methodology (Docs as Tests with AI):
 * every check is an *eval*; what differs is its *grader* (code-based, LLM-as-
 * judge, or human). Verdicts are binary pass/fail — aggregate rates emerge from
 * binary judgments, they are never assigned per item.
 */

// The judge vocabulary is shared with the inference layer and is re-exported
// here so moose-docevals code and its consumers keep one import site. A second local
// definition would be a second thing to keep in sync.
//
//   Match          — a single run's verdict; `partial` counts as fail
//   Zone           — confidence-zone routing for AI-judged evals
//   JudgeVerdict   — the structured verdict of one run (the book's shape)
//   JudgeRun       — one run within an ensemble
//   ConsensusResult — the aggregated outcome for one (page, eval) pair
import type { ConsensusResult } from "@hawkeyexl/inference";

export type {
  ConsensusResult,
  JudgeRun,
  JudgeVerdict,
  Match,
  Zone,
} from "@hawkeyexl/inference";

/**
 * Regression evals guard behavior that must keep working (~100% target pass
 * rate). Capability evals probe what the docs/system can do (~70% target).
 */
export type EvalType = "capability" | "regression";

/** Finding severity for deterministically graded evals. Only `error` affects exit codes. */
export type Severity = "error" | "warning" | "info";

/** How an eval is graded. `tool:*` kinds are built-in adapters for external tools. */
export type GraderKind = "ai" | "command" | "human" | `tool:${string}`;

/** A normalized finding from a deterministically graded eval (command or tool). */
export interface Finding {
  /** Name of the eval that produced this finding. */
  evalName: string;
  /** Repo-relative path of the page the finding applies to. */
  file: string;
  /** Tool-specific rule id (e.g. "MD013", "Vale.Spelling"), when available. */
  ruleId?: string;
  message: string;
  severity: Severity;
  line?: number;
  col?: number;
}

/** Result of one eval applied to one page. */
export interface EvalResult {
  evalName: string;
  /**
   * Suite this result reports under. Stamped centrally by the engine, which
   * already computes the mapping for the suite summaries — the alternative is
   * threading it through every one of the ~30 places a result is constructed.
   */
  suite?: string;
  type: EvalType;
  grader: GraderKind;
  file: string;
  outcome: "pass" | "fail" | "needs-review" | "skipped" | "error";
  /** Present for ai-graded evals. */
  consensus?: ConsensusResult;
  /** Present for command/tool-graded evals that produced findings. */
  findings?: Finding[];
  /** True when this run generated the eval's check script. */
  generated?: boolean;
  /** Set when a persisted human review resolved a needs-review outcome. */
  via?: "human-review";
  skipReason?: string;
  durationMs: number;
}

/** Per-suite aggregate. Pass rates emerge from binary outcomes. */
export interface SuiteSummary {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  skipped: number;
  errored: number;
  /** passed / (total - skipped), 1 when nothing ran. */
  passRate: number;
  /** From config: ~1.0 for regression suites, ~0.7 for capability suites. */
  targetPassRate: number;
  meetsTarget: boolean;
}

/** Full run output consumed by reporters. */
export interface RunReport {
  pages: number;
  evalResults: EvalResult[];
  suites: SuiteSummary[];
  /**
   * Judge telemetry. Counts, not money: the dollar figure this block used to
   * carry was only as good as a price table this repo does not own, and was
   * absent entirely for `claude-cli` and self-hosted endpoints (ADR 01019).
   */
  usage: {
    totalTokens: number;
    cachedEvals: number;
    judgedEvals: number;
  };
  /** Script generations performed during this run (paths written). */
  generated: string[];
  exitCode: 0 | 1;
}

/** Operational/usage error → exit code 2. */
export class DocevalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocevalsError";
  }
}
