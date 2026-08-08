/**
 * Tests for the transport-factory DI seam (Phase 0). The factory is the one
 * place that maps CTA_CHANNEL → a concrete adapter. Phase 0 registers Telegram
 * only; any other channel must throw (no silent fallback / no half-wired Slack).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// TelegramTransport's ctor reads state/env paths — set them before constructing,
// the same seam the transport's own tests use.
const STATE = join(tmpdir(), `transport-factory-test-${process.pid}`);
mkdirSync(STATE, { recursive: true });
process.env.CTA_STATE_DIR = STATE;
process.env.ACCESS_JSON = join(STATE, "access.json");
process.env.TELEGRAM_BOT_TOKEN = "fake";

import { makeOutboundQueue, makeTransport } from "./transport-factory";
import { TelegramTransport } from "./telegram/transport";
import type { ButtonCapable, ChatTransport, MessageRef } from "./types";
import { FileOutboxStore, OutboundSendError } from "../delivery/outbound";

describe("makeTransport", () => {
  test('"telegram" → TelegramTransport', () => {
    expect(makeTransport("telegram")).toBeInstanceOf(TelegramTransport);
  });

  test("default (no arg) → TelegramTransport", () => {
    expect(makeTransport()).toBeInstanceOf(TelegramTransport);
  });

  test("unknown channel throws (no silent fallback)", () => {
    // Slack/discord/line are valid Channel values but not yet registered.
    expect(() => makeTransport("slack" as never)).toThrow(/unsupported/);
    expect(() => makeTransport("bogus" as never)).toThrow(/unsupported/);
  });
});

describe("makeOutboundQueue", () => {
  test("passes text through immediately and awaits the send attempt", async () => {
    const sent: string[] = [];
    const ref: MessageRef = { channel: "telegram", chatId: 1, messageId: 1 };
    const transport: ChatTransport = {
      channel: "telegram",
      transportVersion: 1,
      capabilities: new TelegramTransport().capabilities,
      async start() {},
      async stop() {},
      onEvent() {},
      async whoami() { return { id: "1" }; },
      async sendText({ text }) { sent.push(text); return ref; },
      mountCacheKey() { return "telegram:dm"; },
      routingKey() { return "dm" as never; },
    };

    await makeOutboundQueue(transport).enqueue({
      kind: "text",
      to: { channel: "telegram", chatId: 1 },
      text: "hello",
    });

    expect(sent).toEqual(["hello"]);
  });

  test("degrades buttons to plain text when the transport lacks that capability", async () => {
    const sent: string[] = [];
    const transport: ChatTransport = {
      channel: "telegram",
      transportVersion: 1,
      capabilities: new TelegramTransport().capabilities,
      async start() {},
      async stop() {},
      onEvent() {},
      async whoami() { return { id: "1" }; },
      async sendText({ text }) {
        sent.push(text);
        return { channel: "telegram", chatId: 1, messageId: 1 };
      },
      mountCacheKey() { return "telegram:dm"; },
      routingKey() { return "dm" as never; },
    };

    await makeOutboundQueue(transport).enqueue({
      kind: "buttons",
      to: { channel: "telegram", chatId: 1 },
      text: "Choose:",
      buttons: ["A"],
    });

    expect(sent).toEqual(["Choose:"]);
  });

  test("returns the real send result and deduplicates a stable delivery key", async () => {
    let sends = 0;
    const transport: ChatTransport = {
      channel: "telegram",
      transportVersion: 1,
      capabilities: new TelegramTransport().capabilities,
      async start() {},
      async stop() {},
      onEvent() {},
      async whoami() { return { id: "1" }; },
      async sendText() {
        sends += 1;
        return { channel: "telegram", chatId: 1, messageId: 700 + sends };
      },
      mountCacheKey() { return "telegram:dm"; },
      routingKey() { return "dm" as never; },
    };
    const queue = makeOutboundQueue(transport, {
      mode: "enforced",
      rootDir: join(STATE, `tracked-${Date.now()}-${Math.random()}`),
    });
    const message = {
      kind: "text" as const,
      to: { channel: "telegram" as const, chatId: 1 },
      text: "stable",
      deliveryKey: "approval:123",
    };

    const first = await queue.enqueueTracked(message);
    const second = await queue.enqueueTracked(message);
    await queue.stop();

    expect(first).toEqual({
      status: "delivered",
      messageRef: { channel: "telegram", chatId: 1, messageId: 701 },
    });
    expect(second).toEqual(first);
    expect(sends).toBe(1);
  });

  test("persists structured inline buttons instead of taking the shadow fallback", async () => {
    const rootDir = join(STATE, `buttons-${Date.now()}-${Math.random()}`);
    let sends = 0;
    const transport: ChatTransport & ButtonCapable = {
      channel: "telegram",
      transportVersion: 1,
      capabilities: new TelegramTransport().capabilities,
      async start() {},
      async stop() {},
      onEvent() {},
      async whoami() { return { id: "1" }; },
      async sendText() { throw new Error("button path must not degrade to text"); },
      async sendButtons({ to }) {
        sends += 1;
        return { channel: "telegram", chatId: to.chatId, messageId: 800 + sends };
      },
      mountCacheKey() { return "telegram:dm"; },
      routingKey() { return "dm" as never; },
    };
    const queue = makeOutboundQueue(transport, { mode: "shadow", rootDir });

    const result = await queue.enqueueTracked({
      kind: "buttons",
      to: { channel: "telegram", chatId: 1 },
      text: "Choose:",
      buttons: [{ label: "A", action: "act:A" }],
    });
    await queue.stop();

    expect(result.status).toBe("delivered");
    expect(sends).toBe(1);
    const completed = new FileOutboxStore(rootDir).listCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].message).toMatchObject({
      kind: "buttons",
      buttons: [{ label: "A", action: "act:A" }],
    });
  });

  test("carries Telegram 429 classification into the enforced retry schedule", async () => {
    const rootDir = join(STATE, `rate-limit-${Date.now()}-${Math.random()}`);
    const transport: ChatTransport = {
      channel: "telegram",
      transportVersion: 1,
      capabilities: new TelegramTransport().capabilities,
      async start() {},
      async stop() {},
      onEvent() {},
      async whoami() { return { id: "1" }; },
      async sendText() {
        throw new OutboundSendError({
          kind: "rate_limited",
          message: "Too Many Requests",
          retryable: true,
          retryAfterMs: 7_000,
          httpStatus: 429,
          telegramErrorCode: 429,
        });
      },
      mountCacheKey() { return "telegram:dm"; },
      routingKey() { return "dm" as never; },
    };
    const queue = makeOutboundQueue(transport, { mode: "enforced", rootDir });

    const result = await queue.enqueueTracked({
      kind: "text",
      to: { channel: "telegram", chatId: 1 },
      text: "retry me",
    });
    await queue.stop();

    expect(result.status).toBe("retry_scheduled");
    expect(new FileOutboxStore(rootDir).listPending()[0]).toMatchObject({
      state: "retry_wait",
      failure: { kind: "rate_limited", retryAfterMs: 7_000, httpStatus: 429 },
    });
  });
});
