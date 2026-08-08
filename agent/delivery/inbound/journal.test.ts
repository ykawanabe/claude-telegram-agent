import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
