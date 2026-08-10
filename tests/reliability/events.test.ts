import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  test("bounds the in-memory sink with an ordered ring", () => {
    const sink = new MemoryEventSink(2);
    const reporter = new StructuredEventReporter({ source: "test", sink, bootId: "boot" });
    reporter.emit("process.rss", { rssBytes: 1 });
    reporter.emit("process.rss", { rssBytes: 2 });
    reporter.emit("process.rss", { rssBytes: 3 });

    expect(sink.events.map((event) => event.data)).toEqual([{ rssBytes: 2 }, { rssBytes: 3 }]);
    expect(sink.diagnostics()).toEqual({ retained: 2, dropped: 1, capacity: 2 });
  });

  test("rotates JSONL at a finite byte and file count", () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-observability-"));
    tempDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const reporter = new StructuredEventReporter({
      source: "test",
      sink: new JsonlEventSink(path, { maxBytes: 500, maxFiles: 3, maxEventBytes: 400 }),
      bootId: "boot",
    });
    for (let index = 0; index < 20; index += 1) {
      reporter.emit("process.rss", { rssBytes: index });
    }

    const names = readdirSync(dir).filter((name) => name.startsWith("events.jsonl"));
    expect(names.sort()).toEqual(["events.jsonl", "events.jsonl.1", "events.jsonl.2"]);
    expect(names.every((name) => statSync(join(dir, name)).size <= 500)).toBe(true);
    expect(names.every((name) => (statSync(join(dir, name)).mode & 0o777) === 0o600)).toBe(true);
    expect(readEventLog(path).events.at(-1)?.data).toEqual({ rssBytes: 19 });
  });

  test("contains an event larger than the configured line bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-observability-"));
    tempDirs.push(dir);
    const reporter = new StructuredEventReporter({
      source: "test",
      sink: new JsonlEventSink(join(dir, "events.jsonl"), {
        maxBytes: 512,
        maxFiles: 1,
        maxEventBytes: 128,
      }),
      bootId: "boot",
    });

    expect(() => reporter.emit("observability.sampling_error", {
      sampler: "oversize",
      error: "x".repeat(1_000),
    })).not.toThrow();
    expect(reporter.diagnostics()).toMatchObject({ emitted: 1, sinkFailures: 1 });
  });

  test("bounds and secures a legacy oversized log before appending", () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-observability-"));
    tempDirs.push(dir);
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "legacy-line\n".repeat(100), { mode: 0o644 });
    const reporter = new StructuredEventReporter({
      source: "test",
      sink: new JsonlEventSink(path, { maxBytes: 500, maxFiles: 2, maxEventBytes: 400 }),
      bootId: "boot",
    });

    reporter.emit("process.rss", { rssBytes: 1 });
    const names = readdirSync(dir).filter((name) => name.startsWith("events.jsonl"));
    expect(names.every((name) => statSync(join(dir, name)).size <= 500)).toBe(true);
    expect(names.every((name) => (statSync(join(dir, name)).mode & 0o777) === 0o600)).toBe(true);
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
    expect(result.truncatedPrefixBytes).toBe(0);
    expect(() => readEventLog(path, { onCorrupt: "throw" })).toThrow("corrupt observability log line 2");
  });

  test("tail-reads an externally oversized log within maxBytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-observability-"));
    tempDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const memory = new MemoryEventSink();
    const reporter = new StructuredEventReporter({ source: "test", sink: memory, bootId: "boot" });
    reporter.emit("process.rss", { rssBytes: 1 });
    reporter.emit("process.rss", { rssBytes: 2 });
    reporter.emit("process.rss", { rssBytes: 3 });
    const lines = memory.events.map((event) => `${JSON.stringify(event)}\n`);
    writeFileSync(path, lines.join(""));

    const result = readEventLog(path, { maxBytes: Buffer.byteLength(lines[2]) + 8 });
    expect(result.events.map((event) => event.data)).toEqual([{ rssBytes: 3 }]);
    expect(result.truncatedPrefixBytes).toBeGreaterThan(0);
  });
});
