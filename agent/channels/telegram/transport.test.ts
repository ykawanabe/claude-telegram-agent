/**
 * Tests for TelegramTransport (P2). Two layers:
 *   - pure: capabilities struct + normalizeUpdate (no network);
 *   - wire: methods routed at a local fake Bot API (TELEGRAM_API_BASE), the
 *     same seam the poller's own tests + the E2E harness use.
 * Plus a conformance check that the class satisfies ChatTransport + the optional
 * interfaces it advertises (compile-time assignment + runtime type guards).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── env must be set before constructing the transport (ctor reads paths/env) ─
const STATE = join(tmpdir(), `tg-transport-test-${process.pid}`);
mkdirSync(STATE, { recursive: true });
const ACCESS_JSON = join(STATE, "access.json");
process.env.CTA_STATE_DIR = STATE;
process.env.ACCESS_JSON = ACCESS_JSON;
process.env.TELEGRAM_BOT_TOKEN = "fake";
process.env.POLL_TIMEOUT_SEC = "1";
process.env.TYPING_INTERVAL_MS = "50"; // short keepalive loop so tests don't linger
process.env.TYPING_MAX_MS = "500";

// ─── fake Bot API ─────────────────────────────────────────────────────────────
type Sent = { chat_id: number | string; message_thread_id?: number; text: string; reply_markup?: unknown };
type Reaction = { chat_id: number; message_id: number; reaction: Array<{ type: string; emoji: string }> };
const sent: Sent[] = [];
const reactions: Reaction[] = [];
const edits: Array<{ chat_id: number; message_id: number; text: string }> = [];
let updateQueue: unknown[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.endsWith("/getMe")) {
      return Response.json({ ok: true, result: { id: 4242, username: "pager_bot" } });
    }
    if (p.endsWith("/getUpdates")) {
      const out = updateQueue;
      updateQueue = [];
      if (out.length === 0) await new Promise((r) => setTimeout(r, 30)); // avoid hot spin
      return Response.json({ ok: true, result: out });
    }
    if (p.endsWith("/sendMessage")) {
      const body = (await req.json()) as Sent;
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    if (p.endsWith("/setMessageReaction")) {
      reactions.push((await req.json()) as Reaction);
      return Response.json({ ok: true, result: true });
    }
    if (p.endsWith("/editMessageText")) {
      edits.push((await req.json()) as { chat_id: number; message_id: number; text: string });
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: true });
  },
});
process.env.TELEGRAM_API_BASE = `http://localhost:${server.port}/botfake`;

afterAll(() => {
  server.stop(true);
  rmSync(STATE, { recursive: true, force: true });
});

// Import AFTER env is set so the adapter's lazy getApiBase() resolves the mock.
const { TelegramTransport, normalizeUpdate } = await import("./transport");
const guards = await import("../types");

beforeEach(() => {
  sent.length = 0;
  reactions.length = 0;
  edits.length = 0;
  updateQueue = [];
  writeFileSync(ACCESS_JSON, JSON.stringify({ ackReaction: "👀" }));
});

describe("capabilities", () => {
  const t = new TelegramTransport();
  test("reports Telegram platform truth", () => {
    expect(t.channel).toBe("telegram");
    expect(t.transportVersion).toBe(1);
    expect(t.capabilities.inboundTransport).toBe("long-poll");
    expect(t.capabilities.threadModel).toBe("forum-topic");
    expect(t.capabilities.ackMechanism).toBe("reaction-swap");
    expect(t.capabilities.text.maxChars).toBe(4096);
    expect(t.capabilities.reaction.maxPerBotPerMessage).toBe(1);
    expect(t.capabilities.reaction.canStack).toBe(false);
  });
  test("ack whitelist contains the product's glyphs (👀 default, 👌 read)", () => {
    expect(t.capabilities.reaction.allowedEmoji).toContain("👀");
    expect(t.capabilities.reaction.allowedEmoji).toContain("👌");
  });
});

describe("conformance (type guards reflect implemented interfaces)", () => {
  const t = new TelegramTransport();
  test("implements editable / reactable / typing / buttons / proactive", () => {
    expect(guards.isEditable(t)).toBe(true);
    expect(guards.isReactable(t)).toBe(true);
    expect(guards.isTyping(t)).toBe(true);
    expect(guards.isButtonCapable(t)).toBe(true);
    expect(guards.isProactive(t)).toBe(true);
  });
  test("does NOT advertise the deferred interfaces (files/slash)", () => {
    expect(guards.isFileCapable(t)).toBe(false);
    expect(guards.isSlashCommandable(t)).toBe(false);
  });
});

describe("wire methods route at the Bot API", () => {
  const t = new TelegramTransport();

  test("sendText posts to a chat + thread", async () => {
    await t.sendText({ to: { channel: "telegram", chatId: -100, threadId: 42 }, text: "hello" });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("hello");
    expect(sent[0].message_thread_id).toBe(42);
  });

  test("sendText chunks text above maxChars", async () => {
    const big = "x".repeat(5000);
    await t.sendText({ to: { channel: "telegram", chatId: 1 }, text: big });
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((s) => s.text.length <= 4096)).toBe(true);
  });

  test("setDeliveredAck uses the operator glyph; null when disabled", async () => {
    const ref = { channel: "telegram" as const, chatId: 7, messageId: 9 };
    const h = await t.setDeliveredAck(ref);
    expect(h).not.toBeNull();
    expect(reactions[0].reaction[0].emoji).toBe("👀");

    writeFileSync(ACCESS_JSON, JSON.stringify({ ackReaction: "" })); // operator disabled
    reactions.length = 0;
    const h2 = await t.setDeliveredAck(ref);
    expect(h2).toBeNull();
    expect(reactions).toHaveLength(0);
  });

  test("setDeliveredAck returns null on malformed access.json (no throw)", async () => {
    writeFileSync(ACCESS_JSON, "{ not valid json");
    reactions.length = 0;
    const h = await t.setDeliveredAck({ channel: "telegram", chatId: 1, messageId: 1 });
    expect(h).toBeNull();
    expect(reactions).toHaveLength(0);
  });

  test("setReadAcks flips many handles to 👌 (N:1 flush)", async () => {
    const handles = await Promise.all([
      t.setDeliveredAck({ channel: "telegram", chatId: 1, messageId: 1 }),
      t.setDeliveredAck({ channel: "telegram", chatId: 1, messageId: 2 }),
    ]);
    reactions.length = 0;
    await t.setReadAcks(handles.filter((h): h is NonNullable<typeof h> => h != null));
    expect(reactions).toHaveLength(2);
    expect(reactions.every((r) => r.reaction[0].emoji === "👌")).toBe(true);
  });

  test("editText edits in place", async () => {
    await t.editText({ channel: "telegram", chatId: 3, messageId: 5 }, "edited");
    expect(edits[0]).toEqual({ chat_id: 3, message_id: 5, text: "edited" });
  });

  test("sendButtons sends an inline keyboard with ans:<tid>:<label> callback_data", async () => {
    const ref = await t.sendButtons({ to: { channel: "telegram", chatId: 8, threadId: 42 }, text: "pick", buttons: ["A", "B"] });
    expect(ref.channel).toBe("telegram");
    const markup = sent[0].reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(markup).toBeDefined();
    // callback_data encodes the thread so handleCallbackQuery routes the tap
    // back into the right topic; the keyboard itself posts to the topic.
    expect(markup.inline_keyboard[0][0]).toEqual({ text: "A", callback_data: "ans:42:A" });
    expect(markup.inline_keyboard[1][0].callback_data).toBe("ans:42:B");
    expect(sent[0].message_thread_id).toBe(42);
  });

  test("sendButtons with no thread → ans:dm:<label> + no message_thread_id", async () => {
    await t.sendButtons({ to: { channel: "telegram", chatId: 8 }, text: "pick", buttons: ["Yes"] });
    const markup = sent[0].reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(markup.inline_keyboard[0][0].callback_data).toBe("ans:dm:Yes");
    expect(sent[0].message_thread_id).toBeUndefined();
  });

  test("whoami returns the bot identity", async () => {
    const me = await t.whoami();
    expect(me.id).toBe("4242");
    expect(me.username).toBe("pager_bot");
  });

  test("startTyping writes the typing marker; clearTypingExternal removes it", async () => {
    const addr = { channel: "telegram" as const, chatId: -100, threadId: 42 };
    const markerPath = join(STATE, "typing", "-100__42.token");
    await t.startTyping(addr); // marker written synchronously; keepalive loop fire-and-forget
    expect(existsSync(markerPath)).toBe(true);
    await t.clearTypingExternal(addr);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("key derivation", () => {
  const t = new TelegramTransport();
  test("mountCacheKey + routingKey match the store / registry formats", () => {
    expect(t.mountCacheKey({ channel: "telegram", chatId: -100, threadId: 42 })).toBe("telegram:42");
    expect(t.mountCacheKey({ channel: "telegram", chatId: -100 })).toBe("telegram:dm");
    expect(t.routingKey({ channel: "telegram", chatId: -100, threadId: 42 })).toBe("42");
    expect(t.routingKey({ channel: "telegram", chatId: -100 })).toBe("dm");
  });
});

describe("normalizeUpdate (pure)", () => {
  test("message → message event with normalized fields + raw", () => {
    const ev = normalizeUpdate({
      update_id: 1,
      message: { message_id: 11, from: { id: 99 }, chat: { id: -100 }, message_thread_id: 42, text: "hi" },
    });
    expect(ev?.kind).toBe("message");
    if (ev?.kind === "message") {
      expect(ev.text).toBe("hi");
      expect(ev.routingKey).toBe("42");
      expect(ev.from.id).toBe("99");
      expect(ev.messageRef).toEqual({ channel: "telegram", chatId: -100, messageId: 11 });
      expect(ev.raw.update_id).toBe(1);
    }
  });

  test("DM/General (no thread) routes to 'dm'", () => {
    const ev = normalizeUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 5 }, text: "yo" } });
    expect(ev?.kind === "message" && ev.routingKey).toBe("dm");
  });

  test("edited_message is ignored, NOT replayed as a fresh turn", () => {
    // Editing an OLD message (a common phone gesture) must not re-run it as a
    // new turn/command. Only u.message produces a message event.
    const ev = normalizeUpdate({
      update_id: 9,
      edited_message: { message_id: 1, from: { id: 99 }, chat: { id: 5 }, text: "fixed a typo" },
    });
    expect(ev).toBeNull();
  });

  test("forum_topic_created → topic-created (with raw)", () => {
    const ev = normalizeUpdate({
      update_id: 3,
      message: { message_id: 1, chat: { id: -100 }, message_thread_id: 7, forum_topic_created: { name: "Plans" } },
    });
    expect(ev?.kind).toBe("topic-created");
    if (ev?.kind === "topic-created") {
      expect(ev.routingKey).toBe("7");
      expect(ev.name).toBe("Plans");
      expect(ev.raw.update_id).toBe(3);
    }
  });

  test("callback_query → button-press", () => {
    const ev = normalizeUpdate({
      update_id: 4,
      callback_query: { id: "cb1", from: { id: 99 }, message: { chat: { id: -100 }, message_id: 50, message_thread_id: 42 }, data: "A" },
    });
    expect(ev?.kind).toBe("button-press");
    if (ev?.kind === "button-press") {
      expect(ev.label).toBe("A");
      expect(ev.routingKey).toBe("42");
    }
  });

  test("my_chat_member join → joined, leave → removed", () => {
    const base = {
      chat: { id: -100, title: "Proj" },
      from: { id: 7, first_name: "Y" },
    };
    const joined = normalizeUpdate({
      update_id: 5,
      my_chat_member: { ...base, old_chat_member: { user: { id: 4242, is_bot: true }, status: "left" }, new_chat_member: { user: { id: 4242, is_bot: true }, status: "member" } },
    });
    expect(joined?.kind).toBe("joined");
    const removed = normalizeUpdate({
      update_id: 6,
      my_chat_member: { ...base, old_chat_member: { user: { id: 4242, is_bot: true }, status: "member" }, new_chat_member: { user: { id: 4242, is_bot: true }, status: "kicked" } },
    });
    expect(removed?.kind).toBe("removed");
  });

  test("unhandled update kind → null", () => {
    expect(normalizeUpdate({ update_id: 7 })).toBeNull();
  });
});

describe("start/onEvent long-poll loop", () => {
  test("delivers a normalized event from getUpdates, then stops", async () => {
    const t = new TelegramTransport();
    const got: string[] = [];
    let resolveFirst: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    t.onEvent(async (e) => {
      if (e.kind === "message") {
        got.push(e.text);
        resolveFirst();
      }
    });
    const loop = t.start({});
    updateQueue = [{ update_id: 100, message: { message_id: 1, from: { id: 99 }, chat: { id: -100 }, message_thread_id: 42, text: "from-loop" } }];
    await Promise.race([first, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    await t.stop();
    await loop;
    expect(got).toContain("from-loop");
  });

  test("persists an update before dispatch and removes it after success", async () => {
    const t = new TelegramTransport();
    const inboxPath = join(STATE, "inbound-inbox", "150.json");
    let existedDuringDispatch = false;
    let resolveFirst: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    t.onEvent(async (e) => {
      if (e.kind !== "message") return;
      existedDuringDispatch = existsSync(inboxPath);
      resolveFirst();
    });
    updateQueue = [{ update_id: 150, message: { message_id: 2, from: { id: 99 }, chat: { id: -100 }, text: "durable" } }];
    const loop = t.start({});
    await Promise.race([first, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    await t.stop();
    await loop;
    expect(existedDuringDispatch).toBe(true);
    expect(existsSync(inboxPath)).toBe(false);
  });

  test("replays a durable inbox record before polling", async () => {
    const inboxDir = join(STATE, "inbound-inbox");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "200.json"), JSON.stringify({
      update_id: 200,
      message: { message_id: 3, from: { id: 99 }, chat: { id: -100 }, text: "recovered" },
    }));
    const t = new TelegramTransport();
    const got: string[] = [];
    t.onEvent(async (e) => {
      if (e.kind === "message") {
        got.push(e.text);
        await t.stop();
      }
    });
    await t.start({});
    expect(got).toEqual(["recovered"]);
    expect(existsSync(join(inboxDir, "200.json"))).toBe(false);
    expect(Number(readFileSync(join(STATE, "poller-offset"), "utf8").trim())).toBeGreaterThanOrEqual(201);
  });
});

describe("interruptInbound — wake-event abort", () => {
  test("advertises InboundInterruptible capability", () => {
    const t = new TelegramTransport();
    expect(guards.isInterruptible(t)).toBe(true);
    expect(typeof (t as { interruptInbound?: unknown }).interruptInbound).toBe("function");
  });

  test("aborts in-flight getUpdates and retries immediately (no 5s blind sleep)", async () => {
    // Fake server holds the long-poll open for 10s normally; the test's wake
    // signal must abort it well inside that window. We measure the gap between
    // the abort call and the NEXT getUpdates call landing on the fake server
    // — pre-fix that gap was ≥ 5s (the blind backoff after the AbortError
    // catch); post-fix it's near-zero.
    const realFetch = globalThis.fetch;
    let getUpdatesCalls = 0;
    let firstCallStartedAt = 0;
    let secondCallStartedAt = 0;
    globalThis.fetch = (async (...args: Parameters<typeof realFetch>) => {
      const url = String(args[0]);
      if (url.includes("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          firstCallStartedAt = Date.now();
          // Long-block this call so the abort path is exercised. Resolved via
          // the signal (abort propagation through fetch's standard contract).
          const init = args[1] as RequestInit | undefined;
          const signal = init?.signal;
          return await new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(Response.json({ ok: true, result: [] })),
              10_000,
            );
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            }, { once: true });
          });
        }
        if (getUpdatesCalls === 2) secondCallStartedAt = Date.now();
      }
      return realFetch(...args);
    }) as typeof globalThis.fetch;

    try {
      const t = new TelegramTransport();
      t.onEvent(async () => {});
      const loop = t.start({});

      // Wait until the first getUpdates is actually in flight, then fire the
      // wake interrupt. Spin until firstCallStartedAt is set; 500ms ceiling.
      const armDeadline = Date.now() + 500;
      while (firstCallStartedAt === 0 && Date.now() < armDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(firstCallStartedAt).toBeGreaterThan(0);

      const abortAt = Date.now();
      t.interruptInbound();

      // Wait for the retry (second call) to land. <1s if the abort path
      // skipped the 5s sleep; ≥5s otherwise. 2s deadline.
      const retryDeadline = Date.now() + 2000;
      while (secondCallStartedAt === 0 && Date.now() < retryDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await t.stop();
      await loop;
      expect(secondCallStartedAt).toBeGreaterThan(0);
      expect(secondCallStartedAt - abortAt).toBeLessThan(1000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("interruptInbound is a no-op when no poll is in flight", () => {
    const t = new TelegramTransport();
    // start() has not been called → currentPollAbort is undefined. The call
    // must not throw, and must not leave any side-effect that would corrupt
    // a future start().
    expect(() => t.interruptInbound()).not.toThrow();
  });
});
