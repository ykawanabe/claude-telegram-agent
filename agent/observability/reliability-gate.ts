import { StructuredEventReporter, type ReliabilityMode } from "./events";
import type { ReliabilityMetricsSnapshot } from "./metrics";

export interface ReliabilityThresholds {
  maxQueueDepth?: number;
  minQueueSamples?: number;
  maxTurnP95Ms?: number;
  minTurnSamples?: number;
  maxTelegramFailureRate?: number;
  minTelegramSamples?: number;
  maxRssBytes?: number;
  minRssSamples?: number;
  maxCrashCount?: number;
}

export interface ReliabilityViolation {
  check: string;
  actual: number;
  threshold: number;
}

export interface ReliabilityDecision {
  mode: ReliabilityMode;
  allowed: boolean;
  wouldBlock: boolean;
  evidenceSufficient: boolean;
  missingEvidence: ReliabilityEvidenceGap[];
  violations: ReliabilityViolation[];
  consecutiveHealthyWindows: number;
  promotionReady: boolean;
}

export interface ReliabilityEvidenceGap {
  metric: string;
  actual: number;
  required: number;
}

export interface ReliabilityGateOptions {
  mode?: ReliabilityMode;
  thresholds: ReliabilityThresholds;
  reporter?: StructuredEventReporter;
  /** Number of clean evaluation windows before shadow reports promotion-ready. */
  healthyWindowsForPromotion?: number;
}

export class ReliabilityPolicyError extends Error {
  readonly code = "ERELIABILITY";

  constructor(readonly decision: ReliabilityDecision) {
    const reasons = [
      ...decision.violations.map((violation) => violation.check),
      ...decision.missingEvidence.map((gap) => `insufficient-${gap.metric}`),
    ];
    super(`reliability policy blocked operation: ${reasons.join(", ")}`);
    this.name = "ReliabilityPolicyError";
  }
}

/** Shadow is the safe default. In shadow, violations are recorded and the
 * operation remains allowed. Enforced applies the identical comparisons and
 * also fails closed until every configured metric has minimum evidence. */
export class ReliabilityGate {
  readonly mode: ReliabilityMode;
  private consecutiveHealthyWindows = 0;
  private readonly healthyWindowsForPromotion: number;

  constructor(private readonly options: ReliabilityGateOptions) {
    this.mode = options.mode ?? reliabilityModeFromEnvironment();
    this.healthyWindowsForPromotion = options.healthyWindowsForPromotion ?? 12;
    if (!Number.isSafeInteger(this.healthyWindowsForPromotion) || this.healthyWindowsForPromotion <= 0) {
      throw new Error("healthyWindowsForPromotion must be a positive integer");
    }
    options.reporter?.emit("reliability.mode_selected", {
      mode: this.mode,
      origin: options.mode
        ? "explicit"
        : process.env.CTA_RELIABILITY_MODE
          ? "environment"
          : "default",
    });
  }

  evaluate(snapshot: ReliabilityMetricsSnapshot): ReliabilityDecision {
    const violations = compareSnapshot(snapshot, this.options.thresholds);
    const missingEvidence = findMissingEvidence(snapshot, this.options.thresholds);
    const evidenceSufficient = missingEvidence.length === 0;
    const healthy = violations.length === 0 && evidenceSufficient;
    this.consecutiveHealthyWindows = healthy ? this.consecutiveHealthyWindows + 1 : 0;
    const wouldBlock = !healthy;
    const allowed = this.mode === "shadow" || !wouldBlock;
    const decision: ReliabilityDecision = {
      mode: this.mode,
      allowed,
      wouldBlock,
      evidenceSufficient,
      missingEvidence,
      violations,
      consecutiveHealthyWindows: this.consecutiveHealthyWindows,
      promotionReady: this.mode === "shadow"
        && this.consecutiveHealthyWindows >= this.healthyWindowsForPromotion,
    };
    this.options.reporter?.emit("reliability.policy_evaluated", decision);
    return decision;
  }

  assertHealthy(snapshot: ReliabilityMetricsSnapshot): ReliabilityDecision {
    const decision = this.evaluate(snapshot);
    if (!decision.allowed) throw new ReliabilityPolicyError(decision);
    return decision;
  }
}

export function reliabilityModeFromEnvironment(
  value = process.env.CTA_RELIABILITY_MODE,
): ReliabilityMode {
  if (value == null || value.trim() === "") return "shadow";
  if (value === "shadow" || value === "enforced") return value;
  throw new Error(`CTA_RELIABILITY_MODE must be shadow or enforced (got ${value})`);
}

export function compareSnapshot(
  snapshot: ReliabilityMetricsSnapshot,
  thresholds: ReliabilityThresholds,
): ReliabilityViolation[] {
  const violations: ReliabilityViolation[] = [];
  if (thresholds.maxQueueDepth != null) {
    const maxDepth = Math.max(0, ...Object.values(snapshot.queues).map((queue) => queue.current));
    addAbove(violations, "queue-depth", maxDepth, thresholds.maxQueueDepth);
  }
  if (thresholds.maxTurnP95Ms != null) {
    addAbove(violations, "turn-p95-ms", snapshot.turns.latency.p95Ms, thresholds.maxTurnP95Ms);
  }
  const minTelegramSamples = thresholds.minTelegramSamples ?? 20;
  if (thresholds.maxTelegramFailureRate != null && snapshot.telegram.attempts >= minTelegramSamples) {
    addAbove(violations, "telegram-failure-rate", snapshot.telegram.failureRate, thresholds.maxTelegramFailureRate);
  }
  if (thresholds.maxRssBytes != null) {
    addAbove(violations, "rss-bytes", snapshot.rss.currentBytes, thresholds.maxRssBytes);
  }
  if (thresholds.maxCrashCount != null) {
    addAbove(violations, "crash-count", snapshot.processes.crashes, thresholds.maxCrashCount);
  }
  return violations;
}

/** Minimum sample counts are evidence gates, not SLO violations. They keep an
 * idle/empty snapshot from being mislabeled healthy or promotion-ready. */
export function findMissingEvidence(
  snapshot: ReliabilityMetricsSnapshot,
  thresholds: ReliabilityThresholds,
): ReliabilityEvidenceGap[] {
  const gaps: ReliabilityEvidenceGap[] = [];
  if (thresholds.maxQueueDepth != null) {
    const samples = Object.values(snapshot.queues)
      .reduce((total, queue) => total + queue.samples, 0);
    addBelow(gaps, "queue-samples", samples, minimum("minQueueSamples", thresholds.minQueueSamples, 1));
  }
  if (thresholds.maxTurnP95Ms != null) {
    addBelow(gaps, "turn-samples", snapshot.turns.latency.count,
      minimum("minTurnSamples", thresholds.minTurnSamples, 20));
  }
  if (thresholds.maxTelegramFailureRate != null) {
    addBelow(gaps, "telegram-samples", snapshot.telegram.attempts,
      minimum("minTelegramSamples", thresholds.minTelegramSamples, 20));
  }
  if (thresholds.maxRssBytes != null) {
    addBelow(gaps, "rss-samples", snapshot.rss.samples,
      minimum("minRssSamples", thresholds.minRssSamples, 1));
  }
  return gaps;
}

function addAbove(
  violations: ReliabilityViolation[],
  check: string,
  actual: number,
  threshold: number,
): void {
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error(`${check} threshold must be non-negative`);
  if (actual > threshold) violations.push({ check, actual, threshold });
}

function addBelow(
  gaps: ReliabilityEvidenceGap[],
  metric: string,
  actual: number,
  required: number,
): void {
  if (actual < required) gaps.push({ metric, actual, required });
}

function minimum(label: string, value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`);
  return result;
}
