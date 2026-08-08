import { describe, expect, test } from "bun:test";
import { runLoadScenario, runSoakScenario } from "./load-harness";

describe("load and soak harness", () => {
  test("runs exact finite load with bounded concurrency and threshold verdict", async () => {
    let active = 0;
    let maxActive = 0;
    const summary = await runLoadScenario({
      operations: 24,
      concurrency: 4,
      operation: async (index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(1);
        active -= 1;
        if (index === 7) throw new Error("one injected failure");
      },
      thresholds: { maxFailureRate: 0.05, maxP95Ms: 100 },
      rssProvider: () => 1_000,
    });

    expect(summary).toMatchObject({
      kind: "load",
      operations: 24,
      failures: 1,
      failureRate: 1 / 24,
      passed: true,
      rss: { growthBytes: 0 },
    });
    expect(summary.throughputPerSec).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  test("returns a failing verdict without throwing when SLO is exceeded", async () => {
    const summary = await runLoadScenario({
      operations: 4,
      concurrency: 2,
      operation: () => { throw new Error("failed"); },
      thresholds: { maxFailureRate: 0 },
    });
    expect(summary.passed).toBe(false);
    expect(summary.violations[0]).toContain("failure-rate");
  });

  test("soak runner is time bounded and supports target rate", async () => {
    const summary = await runSoakScenario({
      durationMs: 30,
      concurrency: 2,
      targetOperationsPerSec: 200,
      operation: async () => Bun.sleep(1),
      thresholds: { maxFailureRate: 0 },
    });
    expect(summary.kind).toBe("soak");
    expect(summary.operations).toBeGreaterThan(0);
    expect(summary.passed).toBe(true);
  });
});
