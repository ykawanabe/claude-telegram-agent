import { describe, expect, test } from "bun:test";
import type { DaemonEvent } from "../../agent/poller/contracts";
import {
  MemoryEventSink,
  ReliabilityMonitor,
  StructuredEventReporter,
  createObservedDaemonEventSink,
  createSafeReliabilityHooks,
} from "../../agent/observability";

describe("reliability monitor integration", () => {
  test("correlates daemon turn start/end and transparently forwards events", () => {
    let now = 100;
    const memory = new MemoryEventSink();
    const monitor = new ReliabilityMonitor({
      reporter: new StructuredEventReporter({ source: "test", sink: memory, bootId: "boot", now: () => now }),
      now: () => now,
    });
    const forwarded: DaemonEvent[] = [];
    const sink = createObservedDaemonEventSink(monitor, { emit: (event) => forwarded.push(event) });

    sink.emit({ kind: "turn-start", threadId: "42" });
    now = 350;
    sink.emit({ kind: "turn-end", threadId: "42", costUsd: null, sessionId: null });
    sink.emit({ kind: "spawn", threadId: "42", spawnedCount: 1 });
    sink.emit({ kind: "crash", threadId: "42", crashCount: 1, code: 1, signal: null });
    sink.emit({ kind: "spawn-failed", threadId: "42" });
    sink.emit({ kind: "crash-loop", threadId: "42", crashCount: 3 });

    expect(forwarded.map((event) => event.kind)).toEqual([
      "turn-start", "turn-end", "spawn", "crash", "spawn-failed", "crash-loop",
    ]);
    expect(monitor.snapshot().turns.latency).toMatchObject({ count: 1, p95Ms: 250 });
    expect(monitor.snapshot().processes).toMatchObject({ spawnAttempts: 2, spawnFailures: 1, crashes: 1 });
    expect(memory.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.finished",
      "process.spawn",
      "process.crash",
      "process.spawn",
    ]);
  });

  test("safe hooks never throw into delivery paths", () => {
    const monitor = new ReliabilityMonitor({
      reporter: new StructuredEventReporter({
        source: "test",
        sink: { write: () => { throw new Error("ENOSPC"); } },
      }),
      rssProvider: () => { throw new Error("rss unavailable"); },
    });
    const failures: unknown[] = [];
    const hooks = createSafeReliabilityHooks(monitor, (error) => failures.push(error));

    expect(() => hooks.recordQueueDepth("inbound", -1)).not.toThrow();
    expect(() => hooks.sampleRss()).not.toThrow();
    const turnId = hooks.startTurn("42");
    expect(() => hooks.finishTurn("42", turnId, "completed")).not.toThrow();
    expect(failures).toHaveLength(2);
  });

  test("records Telegram result details and RSS", () => {
    const memory = new MemoryEventSink();
    const monitor = new ReliabilityMonitor({
      reporter: new StructuredEventReporter({ source: "test", sink: memory }),
      rssProvider: () => 8_192,
    });
    monitor.recordQueueDepth("outbox", 5, 100);
    monitor.recordTelegramRequest({ operation: "sendMessage", ok: false, status: 429, retryAfterMs: 2_000 });
    monitor.sampleRss();

    expect(monitor.snapshot()).toMatchObject({
      queues: { outbox: { current: 5 } },
      telegram: { attempts: 1, failures: 1, failureRate: 1 },
      rss: { currentBytes: 8_192 },
    });
    expect(memory.events.map((event) => event.type)).toEqual(["queue.depth", "telegram.request", "process.rss"]);
  });
});
