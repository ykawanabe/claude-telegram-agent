import { StructuredEventReporter, type ReliabilityMode } from "./events";
import type { ReliabilityMetricsSnapshot } from "./metrics";

export interface ReliabilityThresholds {
  maxQueueDepth?: number;
  maxTurnP95Ms?: number;
  maxTelegramFailureRate?: number;
  minTelegramSamples?: number;
  maxRssBytes?: number;
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
  violations: ReliabilityViolation[];
  consecutiveHealthyWindows: number;
  promotionReady: boolean;
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
    super(`reliability policy blocked operation: ${decision.violations.map((v) => v.check).join(", ")}`);
    this.name = "ReliabilityPolicyError";
  }
}

/** Shadow is the safe default. In shadow, violations are recorded and the
 * operation remains allowed. Enforced applies the identical comparisons. */
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
    this.consecutiveHealthyWindows = violations.length === 0 ? this.consecutiveHealthyWindows + 1 : 0;
    const wouldBlock = violations.length > 0;
    const allowed = this.mode === "shadow" || !wouldBlock;
    const decision: ReliabilityDecision = {
      mode: this.mode,
      allowed,
      wouldBlock,
      violations,
      consecutiveHealthyWindows: this.consecutiveHealthyWindows,
      promotionReady: this.consecutiveHealthyWindows >= this.healthyWindowsForPromotion,
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

function addAbove(
  violations: ReliabilityViolation[],
  check: string,
  actual: number,
  threshold: number,
): void {
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error(`${check} threshold must be non-negative`);
  if (actual > threshold) violations.push({ check, actual, threshold });
}
