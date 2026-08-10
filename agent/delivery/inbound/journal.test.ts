import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileInboundJournal,
  inboundJournalModeFromEnv,
  type InboundJournalMode,
} from "./index";

interface Payload { text: string; updateId: number }

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CTA_INBOUND_JOURNAL_MODE;
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "inbound-journal-unit-"));
  roots.push(value);
  return value;
}

function journal(dir = root(), mode: InboundJournalMode = "enforced") {
  let token = 0;
  return new FileInboundJournal<Payload>({
    rootDir: dir,
    mode,
    makeToken: () => `token-${++token}`,
  });
}

function payload(updateId: number): Payload {
  return { text: `message-${updateId}`, updateId };
}

describe("FileInboundJournal state machine", () => {
  test("persists received → claimed → dispatched → completed", () => {
    const dir = root();
    const j = journal(dir);
    const received = j.receive({ messageId: "telegram:101", payload: payload(101) });
    expect(received.classification).toBe("new");
    expect(received.action).toBe("process");
    expect(received.managed).toBe(true);
    expect(received.record?.state).toBe("received");

    const claimed = j.claim("telegram:101", "poller-1", 30_000);
    expect(claimed.state).toBe("claimed");
    expect(claimed.attempt).toBe(1);
    const token = claimed.claim!.token;

    expect(j.markDispatched("telegram:101", token).state).toBe("dispatched");
    const completed = j.complete("telegram:101", token);
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.claim).toBeUndefined();
    expect(completed.history.map((h) => h.to)).toEqual([
      "received", "claimed", "dispatched", "completed",
    ]);

    // A new object proves the terminal tombstone is on disk, not in memory.
    expect(journal(dir).get("telegram:101")?.state)
      .toBe("completed");
  });

  test("requires the explicit dispatch boundary and the current claim token", () => {
    const j = journal();
    j.receive({ messageId: "m", payload: payload(1) });
    const claim = j.claim("m", "worker");
    expect(() => j.complete("m", claim.claim!.token)).toThrow("requires state dispatched");
    expect(() => j.markDispatched("m", "stale-token")).toThrow("stale or invalid claim token");
    expect(j.get("m")?.state).toBe("claimed");
  });

  test("releaseClaim makes pre-dispatch failure replayable", () => {
    const j = journal();
    j.receive({ messageId: "m", payload: payload(1) });
    const claim = j.claim("m", "worker");
    const released = j.releaseClaim("m", claim.claim!.token, "handler unavailable");
    expect(released.state).toBe("received");
    expect(released.claim).toBeUndefined();
    expect(j.listReplayable().map((r) => r.messageId)).toEqual(["m"]);
  });

  test("known pre-dispatch loss is terminal and distinct from outcome unknown", () => {
    const j = journal();
    j.receive({ messageId: "lost", payload: payload(1) });
    const claim = j.claim("lost", "worker");
    const lost = j.markLost("lost", claim.claim!.token, "payload rejected without retry");
    expect(lost.state).toBe("uncertain");
    expect(lost.failure?.semantic).toBe("loss");
    expect(j.listReplayable()).toEqual([]);
    expect(j.receive({ messageId: "lost", payload: payload(1) })).toMatchObject({
      classification: "loss",
      failureSemantic: "loss",
      action: "hold",
    });
  });
});

describe("message-ID dedupe and rollout mode", () => {
  test("enforced mode suppresses a duplicate completed message", () => {
    const j = journal();
    j.receive({ messageId: "same-id", payload: payload(1) });
    const claim = j.claim("same-id", "worker");
    j.markDispatched("same-id", claim.claim!.token);
    j.complete("same-id", claim.claim!.token);

    const duplicate = j.receive({ messageId: "same-id", payload: payload(999) });
    expect(duplicate.classification).toBe("duplicate");
    expect(duplicate.failureSemantic).toBe("duplicate");
    expect(duplicate.action).toBe("suppress");
    expect(duplicate.managed).toBe(false);
    // The first durable payload wins; duplicate input cannot rewrite it.
    expect(duplicate.record?.payload).toEqual(payload(1));
    expect(duplicate.record?.duplicates.count).toBe(1);
  });

  test("shadow records would-suppress while allowing the legacy path", () => {
    const j = journal(root(), "shadow");
    j.receive({ messageId: "same-id", payload: payload(1) });
    const duplicate = j.receive({ messageId: "same-id", payload: payload(2) });
    expect(duplicate.action).toBe("process");
    expect(duplicate.wouldEnforce).toBe("suppress");
    expect(duplicate.managed).toBe(false);
    expect(j.summary().shadowWouldSuppress).toBe(1);

    j.setMode("enforced");
    expect(j.receive({ messageId: "same-id", payload: payload(3) }).action).toBe("suppress");
    expect(j.summary().duplicateObservations).toBe(2);
  });

  test("uncertain duplicate is held separately from an ordinary duplicate", () => {
    const j = journal();
    j.receive({ messageId: "maybe", payload: payload(1) });
    const claim = j.claim("maybe", "worker");
    j.markDispatched("maybe", claim.claim!.token);
    j.uncertain("maybe", claim.claim!.token, "connection reset after dispatch");

    const duplicate = j.receive({ messageId: "maybe", payload: payload(1) });
    expect(duplicate.classification).toBe("outcome-unknown");
    expect(duplicate.failureSemantic).toBe("outcome-unknown");
    expect(duplicate.action).toBe("hold");
  });

  test("message IDs are opaque and cannot escape the journal directory", () => {
    const j = journal();
    expect(j.receive({ messageId: "../../outside/\u{1F4E8}", payload: payload(1) }).journaled).toBe(true);
    expect(j.get("../../outside/\u{1F4E8}")?.payload).toEqual(payload(1));
  });

  test("configuration defaults to shadow and rejects typos", () => {
    expect(inboundJournalModeFromEnv()).toBe("shadow");
    process.env.CTA_INBOUND_JOURNAL_MODE = "enforced";
    expect(inboundJournalModeFromEnv()).toBe("enforced");
    process.env.CTA_INBOUND_JOURNAL_MODE = "enforce";
    expect(() => inboundJournalModeFromEnv()).toThrow("must be shadow or enforced");
  });
});

describe("bounded journal capacity and cached summary", () => {
  test("fails closed at active capacity in enforced mode and falls back observably in shadow", () => {
    const enforced = new FileInboundJournal<Payload>({
      rootDir: root(),
      mode: "enforced",
      maxRecords: 2,
      maxReplayBatch: 2,
    });
    enforced.receive({ messageId: "one", payload: payload(1) });
    enforced.receive({ messageId: "two", payload: payload(2) });
    expect(() => enforced.receive({ messageId: "three", payload: payload(3) }))
      .toThrow("active record capacity 2 is exhausted");

    const shadow = new FileInboundJournal<Payload>({
      rootDir: root(),
      mode: "shadow",
      maxRecords: 2,
      maxReplayBatch: 2,
    });
    shadow.receive({ messageId: "one", payload: payload(1) });
    shadow.receive({ messageId: "two", payload: payload(2) });
    expect(shadow.receive({ messageId: "three", payload: payload(3) })).toMatchObject({
      classification: "journal-error",
      action: "process",
      wouldEnforce: "fail-closed",
      managed: false,
      journaled: false,
      failureSemantic: "loss",
      error: expect.stringContaining("active record capacity 2 is exhausted"),
    });
  });

  test("evicts the oldest completed tombstone to keep total files bounded", () => {
    const dir = root();
    const j = new FileInboundJournal<Payload>({
      rootDir: dir,
      mode: "enforced",
      maxRecords: 2,
      maxReplayBatch: 2,
    });
    j.receive({ messageId: "old-completed", payload: payload(1) });
    const claim = j.claim("old-completed", "worker");
    j.markDispatched("old-completed", claim.claim!.token);
    j.complete("old-completed", claim.claim!.token);
    j.receive({ messageId: "pending", payload: payload(2) });

    expect(j.receive({ messageId: "new", payload: payload(3) }).classification).toBe("new");
    expect(j.get("old-completed")).toBeUndefined();
    expect(readdirSync(join(dir, "records")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(j.summary()).toMatchObject({
      storedRecords: 2,
      activeRecords: 2,
      maxRecords: 2,
      maxReplayBatch: 2,
    });
  });

  test("bounds record bytes with the same shadow/enforced failure semantics", () => {
    const oversized = { text: "x".repeat(4_096), updateId: 1 };
    const enforced = new FileInboundJournal<Payload>({
      rootDir: root(),
      mode: "enforced",
      maxRecordBytes: 512,
    });
    expect(() => enforced.receive({ messageId: "large", payload: oversized }))
      .toThrow("maxRecordBytes is 512");

    const shadow = new FileInboundJournal<Payload>({
      rootDir: root(),
      mode: "shadow",
      maxRecordBytes: 512,
    });
    expect(shadow.receive({ messageId: "large", payload: oversized })).toMatchObject({
      classification: "journal-error",
      action: "process",
      wouldEnforce: "fail-closed",
      journaled: false,
      failureSemantic: "loss",
      error: expect.stringContaining("maxRecordBytes is 512"),
    });
  });

  test("summary is incrementally maintained instead of re-reading every record", () => {
    const dir = root();
    const j = journal(dir);
    j.receive({ messageId: "cached", payload: payload(1) });
    expect(j.summary()).toMatchObject({
      states: { received: 1, claimed: 0, dispatched: 0, completed: 0, uncertain: 0 },
      storedRecords: 1,
      activeRecords: 1,
      corruptRecords: 0,
    });

    const recordPath = join(dir, "records", readdirSync(join(dir, "records"))[0]!);
    writeFileSync(recordPath, "{externally-corrupted");

    // The singleton sampler stays O(1) and reports the last journal-owned
    // state. A fresh process/recovery scan reconciles external disk changes.
    expect(j.summary()).toMatchObject({ storedRecords: 1, corruptRecords: 0 });
    expect(journal(dir).summary()).toMatchObject({ storedRecords: 1, corruptRecords: 1 });
  });
});
