import { describe, expect, test } from "bun:test";
import {
  FaultInjectedError,
  FaultInjector,
  MemoryEventSink,
  StructuredEventReporter,
  parseFaultPlan,
} from "../../agent/observability";

describe("deterministic fault injection", () => {
  test("injects timeout before operation and consumes only configured count", async () => {
    let calls = 0;
    const injector = new FaultInjector({ rules: [{ point: "telegram.send", kind: "timeout", times: 1, delayMs: 1 }] });

    await expect(injector.run("telegram.send", () => { calls += 1; return "sent"; })).rejects.toMatchObject({
      code: "ETIMEDOUT",
      fault: "timeout",
    });
    await expect(injector.run("telegram.send", () => { calls += 1; return "sent"; })).resolves.toBe("sent");
    expect(calls).toBe(1);
    expect(injector.pending()).toEqual([]);
  });

  test("injects disk full and kill checkpoints without terminating test runner", async () => {
    const killed: string[] = [];
    const injector = new FaultInjector({
      rules: [
        { point: "outbox.persist", kind: "disk-full" },
        { point: "journal.after-claim", kind: "kill" },
      ],
      onKill: (point) => killed.push(point),
    });

    await expect(injector.run("outbox.persist", () => undefined)).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(injector.run("journal.after-claim", () => undefined)).rejects.toBeInstanceOf(FaultInjectedError);
    expect(killed).toEqual(["journal.after-claim"]);
  });

  test("corrupts serialized state deterministically and emits fault events", () => {
    const memory = new MemoryEventSink();
    const injector = new FaultInjector({
      rules: [{ point: "journal.read", kind: "corrupt-state", corruption: "invalid-json" }],
      reporter: new StructuredEventReporter({ source: "fault-test", sink: memory }),
    });
    const corrupted = injector.corruptState("journal.read", JSON.stringify({ ok: true }));

    expect(() => JSON.parse(corrupted)).toThrow();
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({
      type: "fault.injected",
      data: { point: "journal.read", fault: "corrupt-state" },
    });
  });

  test("disabled injector is a zero-behavior-change pass-through", async () => {
    const injector = new FaultInjector();
    await expect(injector.run("anything", () => 42)).resolves.toBe(42);
    expect(injector.corruptState("anything", "state")).toBe("state");
  });

  test("parses environment plan strictly", () => {
    expect(parseFaultPlan('[{"point":"write","kind":"disk-full","times":2}]')).toEqual([
      { point: "write", kind: "disk-full", times: 2 },
    ]);
    expect(() => parseFaultPlan('[{"point":"write","kind":"fire"}]')).toThrow("invalid kind");
  });
});
