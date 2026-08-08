import { describe, expect, test } from "bun:test";
import { ReliabilityMetrics } from "../../agent/observability";

describe("reliability metrics", () => {
  test("measures queue depth and correlated turn latency/outcomes", () => {
    let now = 1_000;
    const metrics = new ReliabilityMetrics({ now: () => now });

    metrics.recordQueueDepth("inbound", 3);
    metrics.recordQueueDepth("inbound", 1);
    metrics.startTurn("turn-1");
    now = 1_120;
    metrics.finishTurn("turn-1", "completed");
    metrics.startTurn("turn-2");
    now = 1_520;
    metrics.finishTurn("turn-2", "timeout");
    metrics.finishTurn("unknown", "uncertain");

    const snapshot = metrics.snapshot();
    expect(snapshot.queues.inbound).toEqual({ current: 1, max: 3, samples: 2 });
    expect(snapshot.turns).toMatchObject({
      started: 2,
      finished: 3,
      inFlight: 0,
      unmatchedFinishes: 1,
      outcomes: { completed: 1, timeout: 1, failed: 0, uncertain: 1 },
    });
    expect(snapshot.turns.latency).toMatchObject({
      count: 2,
      minMs: 120,
      maxMs: 400,
      averageMs: 260,
      p50Ms: 120,
      p95Ms: 400,
    });
  });

  test("counts spawn/crash, Telegram failure rate/status and RSS high water", () => {
    const metrics = new ReliabilityMetrics({ now: () => 0 });
    metrics.recordSpawn("claude", true);
    metrics.recordSpawn("claude", false);
    metrics.recordCrash("claude", 2);
    metrics.recordTelegramRequest({ ok: true, status: 200, latencyMs: 10 });
    metrics.recordTelegramRequest({ ok: false, status: 429, latencyMs: 30 });
    metrics.recordTelegramRequest({ ok: false });
    metrics.recordRss(100);
    metrics.recordRss(80);

    const snapshot = metrics.snapshot();
    expect(snapshot.processes).toMatchObject({ spawnAttempts: 2, spawnFailures: 1, crashes: 2 });
    expect(snapshot.telegram).toMatchObject({
      attempts: 3,
      failures: 2,
      failureRate: 2 / 3,
      byStatus: { "200": 1, "429": 1, network: 1 },
    });
    expect(snapshot.telegram.latency.averageMs).toBe(20);
    expect(snapshot.rss).toEqual({ currentBytes: 80, maxBytes: 100, samples: 2 });
  });

  test("bounds percentile memory while retaining lifetime counters", () => {
    const metrics = new ReliabilityMetrics({ maxDistributionSamples: 3, now: () => 0 });
    for (let index = 0; index < 10; index += 1) {
      metrics.recordTelegramRequest({ ok: true, latencyMs: index });
    }
    const latency = metrics.snapshot().telegram.latency;
    expect(latency.count).toBe(10);
    expect(latency.minMs).toBe(0);
    expect(latency.maxMs).toBe(9);
    expect(latency.averageMs).toBe(4.5);
    expect(latency.p50Ms).toBeGreaterThanOrEqual(7);
  });
});
