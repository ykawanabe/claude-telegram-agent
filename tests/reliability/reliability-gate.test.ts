import { describe, expect, test } from "bun:test";
import {
  MemoryEventSink,
  ReliabilityGate,
  ReliabilityMetrics,
  ReliabilityPolicyError,
  StructuredEventReporter,
  reliabilityModeFromEnvironment,
} from "../../agent/observability";

function unhealthySnapshot() {
  const metrics = new ReliabilityMetrics({ now: () => 0 });
  metrics.recordQueueDepth("outbox", 12);
  metrics.recordRss(1_000);
  metrics.recordCrash("claude", 2);
  for (let index = 0; index < 10; index += 1) {
    metrics.recordTelegramRequest({ ok: index < 7, status: index < 7 ? 200 : 500 });
  }
  return metrics.snapshot();
}

const thresholds = {
  maxQueueDepth: 10,
  maxTelegramFailureRate: 0.2,
  minTelegramSamples: 10,
  maxRssBytes: 900,
  maxCrashCount: 1,
};

describe("shadow to enforced reliability gate", () => {
  test("defaults to shadow, records would-block, and still allows", () => {
    const memory = new MemoryEventSink();
    const gate = new ReliabilityGate({
      thresholds,
      reporter: new StructuredEventReporter({ source: "test", sink: memory }),
    });
    const decision = gate.assertHealthy(unhealthySnapshot());

    expect(gate.mode).toBe("shadow");
    expect(decision).toMatchObject({ allowed: true, wouldBlock: true, promotionReady: false });
    expect(decision.violations.map((item) => item.check)).toEqual([
      "queue-depth",
      "telegram-failure-rate",
      "rss-bytes",
      "crash-count",
    ]);
    expect(memory.events.map((event) => event.type)).toEqual([
      "reliability.mode_selected",
      "reliability.policy_evaluated",
    ]);
    expect(memory.events[0].data).toEqual({ mode: "shadow", origin: "default" });
  });

  test("enforced applies the same comparison and blocks", () => {
    const gate = new ReliabilityGate({ mode: "enforced", thresholds });
    expect(() => gate.assertHealthy(unhealthySnapshot())).toThrow(ReliabilityPolicyError);
    expect(gate.evaluate(unhealthySnapshot())).toMatchObject({ allowed: false, wouldBlock: true });
  });

  test("announces promotion readiness only after consecutive healthy windows", () => {
    const healthy = new ReliabilityMetrics({ now: () => 0 }).snapshot();
    const gate = new ReliabilityGate({
      mode: "shadow",
      thresholds,
      healthyWindowsForPromotion: 2,
    });
    expect(gate.evaluate(healthy)).toMatchObject({ consecutiveHealthyWindows: 1, promotionReady: false });
    expect(gate.evaluate(healthy)).toMatchObject({ consecutiveHealthyWindows: 2, promotionReady: true });
    expect(gate.evaluate(unhealthySnapshot())).toMatchObject({ consecutiveHealthyWindows: 0, promotionReady: false });
  });

  test("environment parser is fail-closed for unknown modes", () => {
    expect(reliabilityModeFromEnvironment(undefined)).toBe("shadow");
    expect(reliabilityModeFromEnvironment("enforced")).toBe("enforced");
    expect(() => reliabilityModeFromEnvironment("observe")).toThrow("must be shadow or enforced");
  });
});
