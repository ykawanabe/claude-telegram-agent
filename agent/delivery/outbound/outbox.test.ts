import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileOutboxStore } from "./store";
import { PersistentOutbox } from "./outbox";
import {
  OUTBOX_SCHEMA_VERSION,
  OutboundSendError,
  outboxModeFromEnv,
  type OutboundSender,
  type OutboxEvent,
  type OutboxRecord,
} from "./types";

const roots: string[] = [];

function store(name: string): FileOutboxStore {
  const root = join(tmpdir(), `cta-outbox-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  return new FileOutboxStore(root);
}

const message = {
  kind: "text" as const,
  to: { channel: "telegram" as const, chatId: -100, threadId: 42 },
  text: "hello",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PersistentOutbox", () => {
  test("configuration defaults to shadow and rejects typos", () => {
    expect(outboxModeFromEnv(undefined)).toBe("shadow");
    expect(outboxModeFromEnv("enforced")).toBe("enforced");
    expect(() => outboxModeFromEnv("enforce")).toThrow("must be shadow or enforced");
  });

  test("persists before send and stores Telegram's actual message ID", async () => {
    const s = store("success");
    let sawPending = false;
    const sender: OutboundSender = {
      async send() {
        sawPending = s.listPending().some((r) => r.state === "sending");
        return { channel: "telegram", chatId: -100, messageId: 9876 };
      },
    };
    const outbox = new PersistentOutbox({ store: s, sender, mode: "enforced" });

    const result = await outbox.enqueue(message, { id: "turn-1" });

    expect(sawPending).toBe(true);
    expect(result.status).toBe("delivered");
    expect(result.messageRef).toEqual({ channel: "telegram", chatId: -100, messageId: 9876 });
    expect(s.listPending()).toHaveLength(0);
    expect(s.listCompleted()[0].result).toEqual(result.messageRef);
  });

  test("deduplicates a completed application message across store instances", async () => {
    const s = store("dedupe");
    let sends = 0;
    const sender: OutboundSender = {
      async send() {
        sends += 1;
        return { channel: "telegram", chatId: -100, messageId: 10 };
      },
    };
    const first = new PersistentOutbox({ store: s, sender, mode: "enforced" });
    const r1 = await first.enqueue(message, { deduplicationKey: "turn:42:reply:1" });
    const reopened = new PersistentOutbox({ store: new FileOutboxStore(s.rootDir), sender, mode: "enforced" });
    const r2 = await reopened.enqueue(message, { deduplicationKey: "turn:42:reply:1" });

    expect(sends).toBe(1);
    expect(r2.outboxId).toBe(r1.outboxId);
    expect(r2.deduplicated).toBe(true);
    expect(r2.messageRef?.channel === "telegram" && r2.messageRef.messageId).toBe(10);
  });

  test("honours retry_after as a minimum, then replays when due", async () => {
    const s = store("retry-after");
    let now = 10_000;
    let sends = 0;
    const sender: OutboundSender = {
      async send() {
        sends += 1;
        if (sends === 1) {
          throw new OutboundSendError({
            kind: "rate_limited",
            message: "Too Many Requests",
            retryable: true,
            retryAfterMs: 7_000,
            httpStatus: 429,
          });
        }
        return { channel: "telegram", chatId: -100, messageId: 77 };
      },
    };
    const outbox = new PersistentOutbox({
      store: s,
      sender,
      mode: "enforced",
      now: () => now,
      random: () => 0,
      retry: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
    });

    const first = await outbox.enqueue(message, { id: "rate-limited" });
    expect(first.status).toBe("retry_scheduled");
    expect(first.nextAttemptAt).toBe(17_000);
    expect(await outbox.drainDue()).toEqual([]);

    now = 16_999;
    expect(await outbox.drainDue()).toEqual([]);
    now = 17_000;
    const [delivered] = await outbox.drainDue();
    expect(delivered.status).toBe("delivered");
    expect(delivered.messageRef?.channel === "telegram" && delivered.messageRef.messageId).toBe(77);
    expect(sends).toBe(2);
  });

  test("uses bounded exponential equal-jitter for explicit 5xx failures", async () => {
    const s = store("backoff");
    let now = 0;
    const sender: OutboundSender = {
      async send() {
        throw new OutboundSendError({ kind: "server_error", message: "upstream", retryable: true, httpStatus: 503 });
      },
    };
    const outbox = new PersistentOutbox({
      store: s,
      sender,
      mode: "enforced",
      now: () => now,
      random: () => 0.5,
      retry: { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 2_000 },
    });

    const first = await outbox.enqueue(message, { id: "server-down" });
    expect(first.nextAttemptAt).toBe(750); // cap 1000, midpoint random => 750
    now = 750;
    const [second] = await outbox.drainDue();
    expect(second.nextAttemptAt).toBe(2_250); // cap 2000, delay 1500
    now = 2_250;
    const [third] = await outbox.drainDue();
    expect(third.nextAttemptAt).toBe(3_750); // max cap remains 2000
  });

  test("moves exhausted retryable and permanent failures to dead-letter", async () => {
    const retryStore = store("dead-retry");
    let now = 0;
    const retrySender: OutboundSender = {
      async send() {
        throw new OutboundSendError({ kind: "server_error", message: "bad gateway", retryable: true, httpStatus: 502 });
      },
    };
    const retryOutbox = new PersistentOutbox({
      store: retryStore,
      sender: retrySender,
      mode: "enforced",
      now: () => now,
      random: () => 0,
      retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100 },
    });
    const first = await retryOutbox.enqueue(message, { id: "retry-exhausted" });
    now = first.nextAttemptAt!;
    const [dead] = await retryOutbox.drainDue();
    expect(dead.status).toBe("dead_letter");
    expect(dead.attempts).toBe(2);
    expect(retryStore.listDeadLetters()[0].failure?.kind).toBe("server_error");

    const permanentStore = store("dead-permanent");
    const permanent = new PersistentOutbox({
      store: permanentStore,
      mode: "enforced",
      sender: {
        async send() {
          throw new OutboundSendError({ kind: "permanent", message: "chat not found", httpStatus: 400 });
        },
      },
    });
    const rejected = await permanent.enqueue(message, { id: "bad-chat" });
    expect(rejected.status).toBe("dead_letter");
    expect(rejected.failure?.retryable).toBe(false);
  });

  test("shadow records the enforced comparison but never performs a retry", async () => {
    const s = store("shadow");
    let sends = 0;
    const events: OutboxEvent[] = [];
    const outbox = new PersistentOutbox({
      store: s,
      mode: "shadow",
      events: (e) => events.push(e),
      sender: {
        async send() {
          sends += 1;
          throw new OutboundSendError({ kind: "server_error", message: "down", retryable: true, httpStatus: 500 });
        },
      },
    });

    const result = await outbox.enqueue(message, { id: "shadow-1" });
    expect(result.status).toBe("dead_letter");
    expect(result.shadowComparison?.wouldTransitionTo).toBe("retry_wait");
    expect(await outbox.drainDue()).toEqual([]);
    expect(sends).toBe(1);
    expect(events.some((e) => e.name === "outbox.shadow_compared")).toBe(true);
  });
});

describe("outbox fault recovery", () => {
  test("a process killed during sending recovers as uncertain, not duplicate work", async () => {
    const s = store("kill");
    let sends = 0;
    const first = new PersistentOutbox({
      store: s,
      mode: "enforced",
      sender: { async send() { sends += 1; return { channel: "telegram", chatId: 1, messageId: 1 }; } },
    });
    await first.enqueue(message, { id: "killed", dispatchNow: false });
    const queued = s.get("killed")!;
    const sending: OutboxRecord = { ...queued, state: "sending", attempts: 1, updatedAt: queued.updatedAt + 1 };
    s.save(sending); // simulates the last durable write before SIGKILL

    const reopenedStore = new FileOutboxStore(s.rootDir);
    const reopened = new PersistentOutbox({
      store: reopenedStore,
      mode: "enforced",
      sender: { async send() { sends += 1; return { channel: "telegram", chatId: 1, messageId: 2 }; } },
    });
    const [recovered] = reopened.recoverInFlight();

    expect(recovered.state).toBe("uncertain");
    expect(await reopened.drainDue()).toEqual([]);
    expect(sends).toBe(0);
  });

  test("quarantines corrupt pending state without blocking healthy work", async () => {
    const s = store("corrupt");
    writeFileSync(join(s.rootDir, "pending", "broken.json"), "{not-json", { mode: 0o600 });
    const record: OutboxRecord = {
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      id: "healthy",
      mode: "enforced",
      message,
      state: "queued",
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    s.save(record);

    expect(s.listPending().map((r) => r.id)).toEqual(["healthy"]);
    expect(existsSync(join(s.rootDir, "pending", "broken.json"))).toBe(false);
    expect(readdirSync(join(s.rootDir, "corrupt")).some((name) => name.startsWith("broken.json."))).toBe(true);
  });

  test("disk-full persistence failure prevents the network side effect", async () => {
    const s = store("disk-full");
    let sends = 0;
    s.save = () => {
      const error = new Error("no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    };
    const outbox = new PersistentOutbox({
      store: s,
      mode: "enforced",
      sender: { async send() { sends += 1; return { channel: "telegram", chatId: 1, messageId: 1 }; } },
    });

    await expect(outbox.enqueue(message, { id: "must-not-send" })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(sends).toBe(0);
  });
});
