import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlEventSink,
  MemoryEventSink,
  StructuredEventReporter,
  readEventLog,
  type StructuredEventSink,
} from "../../agent/observability";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("structured events", () => {
  test("adds stable schema, ordering, source and correlation context", () => {
    const sink = new MemoryEventSink();
    const reporter = new StructuredEventReporter({
      source: "test-poller",
      sink,
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
      bootId: "boot-1",
    });

    reporter.emit("queue.depth", { queue: "inbound", depth: 2 }, { messageId: "message-7" });
    reporter.emit("process.rss", { rssBytes: 1234 });

    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]).toEqual({
      schemaVersion: 1,
      id: "boot-1:1",
      sequence: 1,
      timestamp: "2026-08-08T00:00:00.000Z",
      source: "test-poller",
      type: "queue.depth",
      context: { messageId: "message-7" },
      data: { queue: "inbound", depth: 2 },
    });
    expect(sink.events[1].sequence).toBe(2);
  });

  test("contains disk-full sink failures and exposes diagnostics", () => {
    const errors: unknown[] = [];
    const diskFullSink: StructuredEventSink = {
      write(): void {
        const error = new Error("no space left on device") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      },
    };
    const reporter = new StructuredEventReporter({
      source: "test",
      sink: diskFullSink,
      bootId: "boot",
      onSinkError: (error) => errors.push(error),
    });

    expect(() => reporter.emit("process.rss", { rssBytes: 1 })).not.toThrow();
    expect(reporter.diagnostics()).toMatchObject({ emitted: 1, sinkFailures: 1 });
    expect(errors).toHaveLength(1);
  });

  test("JSONL reader keeps valid history around corrupt/torn state", () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-observability-"));
    tempDirs.push(dir);
    const path = join(dir, "nested", "events.jsonl");
    const reporter = new StructuredEventReporter({
      source: "test",
      sink: new JsonlEventSink(path),
      bootId: "boot",
    });
    reporter.emit("process.rss", { rssBytes: 10 });
    appendFileSync(path, "{\"torn\":\n");
    reporter.emit("process.rss", { rssBytes: 20 });

    const result = readEventLog(path);
    expect(result.events.map((event) => event.data)).toEqual([{ rssBytes: 10 }, { rssBytes: 20 }]);
    expect(result.corruptLines).toHaveLength(1);
    expect(() => readEventLog(path, { onCorrupt: "throw" })).toThrow("corrupt observability log line 2");
  });
});
