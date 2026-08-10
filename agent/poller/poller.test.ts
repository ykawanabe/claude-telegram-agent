/**
 * Tests for the poller's in-chat command flow.
 *
 * Strategy:
 *   - Override CTA_STATE_DIR to a tmpdir so each test owns its state files.
 *   - Override TELEGRAM_BOT_TOKEN + TELEGRAM_API_BASE so reply() POSTs go to
 *     a local fake server. The fake server records every request so tests
 *     can assert outbound message bodies.
 *   - Import the command handlers directly from poller.ts (they're exported
 *     under `import.meta.main` so importing won't start the loop).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendChatAction } from "../channels/telegram/adapter";

// Spin up a fake Telegram Bot API server. Records sendMessage calls so each
// test can introspect what the poller tried to send.
type SentMessage = {
  chat_id: number | string;
  message_thread_id?: number;
  text: string;
  reply_markup?: { inline_keyboard: unknown };
};
type CallbackAck = { callback_query_id: string; text?: string; show_alert?: boolean };
type ChatAction = { chat_id: number | string; action: string; message_thread_id?: number };
type Reaction = { chat_id: number | string; message_id: number; reaction: Array<{ type: string; emoji: string }> };
const sent: SentMessage[] = [];
const callbackAcks: CallbackAck[] = [];
const chatActions: ChatAction[] = [];
const reactions: Reaction[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/sendMessage")) {
      const body = (await req.json()) as SentMessage;
      sent.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/answerCallbackQuery")) {
      const body = (await req.json()) as CallbackAck;
      callbackAcks.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/sendChatAction")) {
      const body = (await req.json()) as ChatAction;
      chatActions.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/setMessageReaction")) {
      const body = (await req.json()) as Reaction;
      reactions.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: false, description: "not mocked" }), { status: 404 });
  },
});
const FAKE_API = `http://localhost:${server.port}/bot-fake`;
afterAll(() => server.stop());

// Per-test tmpdir for state.
const STATE = join(tmpdir(), `poller-test-${process.pid}-${Date.now()}`);
const PAIRING_CODE_FILE = join(STATE, "pairing-code");
const PAIRED_STATE_FILE = join(STATE, "paired.json");
const MOUNTS_JSON = join(STATE, "mounts.json");
const ACCESS_JSON = join(STATE, "access.json");
process.env.CTA_STATE_DIR = STATE;
process.env.TELEGRAM_BOT_TOKEN = "fake";
process.env.TELEGRAM_API_BASE = FAKE_API;
// ACCESS_JSON MUST be set BEFORE the import — the poller pins it as a
// module-level const at import time. Without this, the cache reloads from
// the real ~/.claude/channels/telegram/access.json and tests get polluted
// by whatever the operator has configured locally.
process.env.ACCESS_JSON = ACCESS_JSON;
delete process.env.MAIN_CHAT_ID; // make sure pre-pair tests start unpaired

// Import after env is set so the module-level constants pick up our overrides.
const poller = await import("./poller");
// The command pipeline now consumes the NORMALIZED InboundEvent. Build test
// events through the real production normalizer so the test exercises
// normalizeUpdate too (and never drifts from the live field mapping).
const { normalizeUpdate } = await import("../channels/telegram/transport");

function resetState(): void {
  sent.length = 0;
  callbackAcks.length = 0;
  chatActions.length = 0;
  reactions.length = 0;
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  poller.refreshPairedIfChanged();
  poller.refreshMountsIfChanged();
  poller._setBotUserIdForTest(99999); // pretend bot id; tests use distinct user ids
}

beforeEach(() => resetState());

// Build the normalized message event the command pipeline now consumes, by
// running the same raw TgMessage we used to pass through the production
// normalizer. Keeps the test's call sites (`tryHandleCommand(msg({...}))`)
// unchanged while validating normalizeUpdate end to end.
function msg(args: {
  text: string;
  chat_id?: number;
  thread_id?: number;
  from_id?: number;
}): poller.InboundMessageEvent {
  const raw: poller.TgMessage = {
    message_id: 1,
    chat: { id: args.chat_id ?? -1001234 },
    from: args.from_id != null ? { id: args.from_id } : undefined,
    message_thread_id: args.thread_id,
    text: args.text,
  };
  const ev = normalizeUpdate({ update_id: 1, message: raw });
  if (ev?.kind !== "message") throw new Error("test msg() did not normalize to a message event");
  return ev;
}

describe("pre-pair state", () => {
  test("legacy MAIN_CHAT_ID alone is ignored (chat-only auth fails closed)", () => {
    process.env.MAIN_CHAT_ID = "-1001";
    try {
      const ev = msg({ text: "hello", chat_id: -1001, from_id: 99 });
      expect(poller.effectiveChatId()).toBeNull();
      expect(poller.effectiveUserId()).toBeNull();
      expect(poller.isAuthorizedInbound(ev)).toBe(false);
    } finally {
      delete process.env.MAIN_CHAT_ID;
    }
  });

  test("paired.json without a valid user_id is rejected", () => {
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify({
      version: 1,
      chat_id: -1001,
      paired_at: new Date().toISOString(),
    }));
    poller.refreshPairedIfChanged();
    expect(poller.effectiveChatId()).toBeNull();
    expect(poller.effectiveUserId()).toBeNull();
  });

  test("/pair with correct code claims chat + writes paired.json + consumes code", async () => {
    writeFileSync(PAIRING_CODE_FILE, "ABCD-EFGH\n");
    poller.refreshPairedIfChanged();

    const handled = await poller.tryHandleCommand(
      msg({ text: "/pair ABCD-EFGH", chat_id: -1001, from_id: 99 }),
    );

    expect(handled).toBe(true);
    expect(existsSync(PAIRED_STATE_FILE)).toBe(true);
    const paired = JSON.parse(readFileSync(PAIRED_STATE_FILE, "utf8")) as poller.PairedState;
    expect(paired.chat_id).toBe(-1001);
    expect(paired.user_id).toBe(99);
    expect(existsSync(PAIRING_CODE_FILE)).toBe(false); // consumed
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0].text).toContain("Paired");
  });

  test("/pair with wrong code does NOT claim chat", async () => {
    writeFileSync(PAIRING_CODE_FILE, "ABCD-EFGH\n");
    poller.refreshPairedIfChanged();

    const handled = await poller.tryHandleCommand(
      msg({ text: "/pair WRONG-CODE", chat_id: -1001, from_id: 99 }),
    );

    expect(handled).toBe(true); // command was consumed (don't fall through)
    expect(existsSync(PAIRED_STATE_FILE)).toBe(false);
    expect(existsSync(PAIRING_CODE_FILE)).toBe(true); // NOT consumed
    expect(sent.some((m) => m.text.includes("did not match"))).toBe(true);
  });

  test("/pair when no pairing-code file is present stays silent", async () => {
    // No pairing-code on disk → either never installed or already consumed.
    // Per security model, stay silent so attackers can't probe.
    poller.refreshPairedIfChanged();

    const handled = await poller.tryHandleCommand(
      msg({ text: "/pair AB7K-9XQR", chat_id: -1001, from_id: 99 }),
    );

    expect(handled).toBe(true);
    expect(sent.length).toBe(0);
    expect(existsSync(PAIRED_STATE_FILE)).toBe(false);
  });

  test("/start (Telegram's first-touch convention) tells the user how to pair", async () => {
    // No paired.json, no pairing-code file — a totally fresh bot getting its
    // first Telegram message ever. Telegram clients auto-send /start.
    poller.refreshPairedIfChanged();
    const handled = await poller.tryHandleCommand(
      msg({ text: "/start", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.some((m) => m.text.includes("waiting to be paired"))).toBe(true);
    expect(sent.some((m) => m.text.includes("/pair"))).toBe(true);
  });

  test("non-/pair commands fall through pre-pair", async () => {
    // /mount, /list etc. pre-pair → return false (not handled), so the caller
    // can drop them silently (no MAIN_CHAT_ID set yet → routeMessage returns
    // null anyway).
    const handled = await poller.tryHandleCommand(
      msg({ text: "/mount /tmp", chat_id: -1001, from_id: 99 }),
    );

    expect(handled).toBe(false);
    expect(sent.length).toBe(0);
  });
});

describe("post-pair state", () => {
  function pair(opts?: { chat_id?: number; user_id?: number }): void {
    const state: poller.PairedState = {
      version: 1,
      chat_id: opts?.chat_id ?? -1001,
      user_id: opts?.user_id ?? 99,
      paired_at: new Date().toISOString(),
    };
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify(state, null, 2));
    poller.refreshPairedIfChanged();
  }

  test("effectiveChatId prefers paired.json over env", () => {
    process.env.MAIN_CHAT_ID = "-999"; // env override
    pair({ chat_id: -1001 });
    try {
      expect(poller.effectiveChatId()).toBe("-1001"); // paired wins
      expect(poller.effectiveUserId()).toBe(99);
    } finally {
      delete process.env.MAIN_CHAT_ID;
    }
  });

  test("/list with no mounts replies friendly message", async () => {
    pair();
    const handled = await poller.tryHandleCommand(
      msg({ text: "/list", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.some((m) => m.text.includes("No mounts"))).toBe(true);
  });

  test("/mount with bad path rejects without writing mounts.json", async () => {
    pair();
    const handled = await poller.tryHandleCommand(
      msg({ text: "/mount /definitely/not/a/dir", chat_id: -1001, thread_id: 42, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.some((m) => m.text.includes("not a directory"))).toBe(true);
    expect(existsSync(MOUNTS_JSON)).toBe(false);
  });

  test("/mount outside of a topic rejects with hint", async () => {
    pair();
    // thread_id absent → user sent /mount in the chat root, not a topic
    const handled = await poller.tryHandleCommand(
      msg({ text: "/mount /tmp", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.some((m) => m.text.includes("inside a forum topic"))).toBe(true);
  });

  test("commands from non-paired user_id are silently dropped (handled, no reply)", async () => {
    pair({ user_id: 99 });
    sent.length = 0;
    const handled = await poller.tryHandleCommand(
      msg({ text: "/list", chat_id: -1001, from_id: 12345 }),
    );
    expect(handled).toBe(true); // consumed so claude doesn't see it
    expect(sent.length).toBe(0); // but no reply leaked
  });

  test("/pair from paired user in same chat is a no-op acknowledgement", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/pair", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.some((m) => m.text.includes("Already paired here"))).toBe(true);
    // paired state unchanged
    const state = JSON.parse(readFileSync(PAIRED_STATE_FILE, "utf8")) as poller.PairedState;
    expect(state.chat_id).toBe(-1001);
  });

  test("/pair from paired user in a NEW chat switches paired.json (no code needed)", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    sent.length = 0;
    const handled = await poller.tryHandleCommand(
      msg({ text: "/pair", chat_id: -2002, from_id: 99 }),
    );
    expect(handled).toBe(true);
    // paired.json now points at the new chat — the killer "1-step switch" UX.
    const state = JSON.parse(readFileSync(PAIRED_STATE_FILE, "utf8")) as poller.PairedState;
    expect(state.chat_id).toBe(-2002);
    expect(state.user_id).toBe(99);
    expect(sent.some((m) => m.text.includes("Switched"))).toBe(true);
  });

  test("/pair from a different user when paired is silently dropped (no state change)", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    sent.length = 0;
    const handled = await poller.tryHandleCommand(
      msg({ text: "/pair", chat_id: -3003, from_id: 8888 }),
    );
    expect(handled).toBe(true); // consumed so claude doesn't see it
    expect(sent.length).toBe(0); // no leak about the bot's pair state
    const state = JSON.parse(readFileSync(PAIRED_STATE_FILE, "utf8")) as poller.PairedState;
    expect(state.chat_id).toBe(-1001); // unchanged
    expect(state.user_id).toBe(99);
  });

  test("/stop with no running turn replies 'Nothing running to stop.'", async () => {
    pair();
    sent.length = 0;
    const handled = await poller.tryHandleCommand(
      msg({ text: "/stop", chat_id: -1001, thread_id: 42, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.some((m) => m.text.includes("Nothing running to stop"))).toBe(true);
  });

  test("/stop from a non-paired user is silently dropped (no reply)", async () => {
    pair({ user_id: 99 });
    sent.length = 0;
    const handled = await poller.tryHandleCommand(
      msg({ text: "/stop", chat_id: -1001, thread_id: 42, from_id: 12345 }),
    );
    expect(handled).toBe(true);  // consumed so claude doesn't see it
    expect(sent.length).toBe(0); // but no reply leaked
  });
});

describe("bot-added intro (/pair <code> flow)", () => {
  // The inline-keyboard auto-pair flow was removed (2026-05-13) because it
  // depended on callback_query delivery, which depends on bot membership
  // state being settled — a chicken/egg in forum groups with admin/privacy
  // caching. The bot now sends a plain text intro pointing the user to
  // `/pair <code>`, which is a Telegram `/command` and is delivered to even
  // non-admin privacy-enabled bots reliably.
  const BOT_ID = 99999;
  const INVITER_ID = 7;
  const CHAT_ID = -1001;

  function botAddedEvent(opts?: { chat_id?: number; inviter_id?: number; status?: string }) {
    return {
      chat: { id: opts?.chat_id ?? CHAT_ID },
      from: { id: opts?.inviter_id ?? INVITER_ID, first_name: "Alice" },
      new_chat_member: { user: { id: BOT_ID, is_bot: true }, status: opts?.status ?? "administrator" },
      old_chat_member: { user: { id: BOT_ID, is_bot: true }, status: "left" },
    };
  }

  test("my_chat_member (bot added) sends plain text intro — no inline keyboard, no pending pair", async () => {
    await poller.handleMyChatMember(botAddedEvent());
    expect(sent.length).toBe(1);
    expect(sent[0].reply_markup).toBeUndefined();
    expect(sent[0].text).toContain("/pair");
    expect(sent[0].text).toContain("cta pair-code");
    // No state mutation — the user has to send /pair <code> to actually pair.
    expect(existsSync(PAIRED_STATE_FILE)).toBe(false);
  });

  test("stale callback pair-confirm declines (no pending pair set anymore)", async () => {
    // Even if a user somehow taps a button from a historical message, the
    // poller no longer stages pendingPair, so the callback returns the
    // "expired" alert and refuses to pair.
    await poller.handleMyChatMember(botAddedEvent());
    const cbEv = normalizeUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: INVITER_ID },
        message: { chat: { id: CHAT_ID }, message_id: 1 },
        data: "pair-confirm",
      },
    });
    if (cbEv?.kind !== "button-press") throw new Error("test: callback did not normalize to button-press");
    await poller.onButtonPress(cbEv);
    expect(existsSync(PAIRED_STATE_FILE)).toBe(false);
    expect(callbackAcks.some((a) => a.show_alert === true && a.text?.includes("expired"))).toBe(true);
  });

  test("bot added when already paired declines (still plain text, no inline)", async () => {
    // Pre-stage paired state.
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify({
      version: 1, chat_id: -7777, user_id: 1, paired_at: new Date().toISOString(),
    }));
    poller.refreshPairedIfChanged();
    sent.length = 0;

    await poller.handleMyChatMember(botAddedEvent({ chat_id: CHAT_ID }));

    // Should reply with "already paired" — single plain reply, no inline keyboard.
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("already paired");
    expect(sent[0].reply_markup).toBeUndefined();
  });

  test("my_chat_member for a non-bot user is ignored", async () => {
    const evt = botAddedEvent();
    evt.new_chat_member.user.id = 12345; // not the bot
    await poller.handleMyChatMember(evt);
    expect(sent.length).toBe(0);
  });
});

describe("plain text (non-command) handling", () => {
  test("plain text returns false (let routeMessage handle it)", async () => {
    const handled = await poller.tryHandleCommand(
      msg({ text: "hello there", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(false);
  });

  test("unknown /command from paired user falls through (claude can see it)", async () => {
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify({
      version: 1, chat_id: -1001, user_id: 99, paired_at: new Date().toISOString(),
    }));
    poller.refreshPairedIfChanged();

    const handled = await poller.tryHandleCommand(
      msg({ text: "/something-not-ours arg", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(false); // pass through to claude
  });
});

// sendTyping (poller wrapper) + the 2-stage ack are now owned by the
// ChatTransport: typing → TypingIndicating.startTyping, ack → Reactable. Their
// coverage lives in channels/telegram/transport.test.ts + the e2e scenarios
// (ack_reaction.sh). The keepalive-loop module tests below still run here (they
// have the fake-Bot-API mock wired) but import the relocated module.
describe("typing keepalive", () => {
  // The keepalive loop's primary contract: re-fire sendChatAction past
  // Telegram's 5s auto-clear, and stop the moment mcp-telegram clears the
  // marker. We use short intervals to keep the test fast.
  test("re-fires sendChatAction until marker is cleared", async () => {
    const tk = await import("../channels/telegram/typing-keepalive");
    const STATE = process.env.CTA_STATE_DIR!;
    chatActions.length = 0;

    // Run keepalive at 30ms cadence. Cancel after ~120ms — expect 3-5 fires
    // (1 initial + ~3 interval ticks before we clear).
    const token = tk.markTypingActive(STATE, -1001, 42);
    const sendCounts: number[] = [];
    const runP = tk.runTypingKeepalive({
      stateDir: STATE,
      chatId: -1001,
      threadId: 42,
      token,
      send: async () => {
        sendCounts.push(Date.now());
        await sendChatAction(-1001, 42);
      },
      intervalMs: 30,
      maxMs: 5_000,
    });

    await new Promise((r) => setTimeout(r, 120));
    expect(sendCounts.length).toBeGreaterThanOrEqual(3);

    tk.markTypingDone(STATE, -1001, 42);
    await runP;
    const fires = sendCounts.length;

    // Confirm no further fires after the marker is gone.
    await new Promise((r) => setTimeout(r, 80));
    expect(sendCounts.length).toBe(fires);

    // Every fire should have hit sendChatAction with the right target.
    expect(chatActions.length).toBe(fires);
    for (const a of chatActions) {
      expect(a.chat_id).toBe(-1001);
      expect(a.action).toBe("typing");
      expect(a.message_thread_id).toBe(42);
    }
  });

  test("stops when a newer dispatch replaces the marker token", async () => {
    const tk = await import("../channels/telegram/typing-keepalive");
    const STATE = process.env.CTA_STATE_DIR!;

    const oldToken = tk.markTypingActive(STATE, -1001, 7);
    let fires = 0;
    const runP = tk.runTypingKeepalive({
      stateDir: STATE,
      chatId: -1001,
      threadId: 7,
      token: oldToken,
      send: async () => { fires++; },
      intervalMs: 25,
      maxMs: 5_000,
    });

    await new Promise((r) => setTimeout(r, 60));
    // Simulate a newer message arriving: marker overwritten with a new token.
    tk.markTypingActive(STATE, -1001, 7);
    await runP;

    const afterStop = fires;
    await new Promise((r) => setTimeout(r, 60));
    expect(fires).toBe(afterStop);
  });

  test("dm keepalive uses the 'dm' sentinel path", async () => {
    const tk = await import("../channels/telegram/typing-keepalive");
    const STATE = process.env.CTA_STATE_DIR!;
    const expected = tk.typingMarkerPath(STATE, 8000000000, undefined);
    expect(expected.endsWith("8000000000__dm.token")).toBe(true);

    // markTypingDone should accept the same undefined/dm shape mcp-telegram
    // would synthesize for a DM, and undelete cleanly.
    tk.markTypingActive(STATE, 8000000000);
    tk.markTypingDone(STATE, 8000000000, "dm");
    // Second call is a no-op (file already gone) — must not throw.
    expect(() => tk.markTypingDone(STATE, 8000000000)).not.toThrow();
  });
});

describe("claude built-in interception (post-pair)", () => {
  function pair(opts?: { chat_id?: number; user_id?: number }): void {
    const state: poller.PairedState = {
      version: 1,
      chat_id: opts?.chat_id ?? -1001,
      user_id: opts?.user_id ?? 99,
      paired_at: new Date().toISOString(),
    };
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify(state, null, 2));
    poller.refreshPairedIfChanged();
  }

  beforeEach(() => { sent.length = 0; });

  test("/status runs cta status and posts the result, NOT passed to claude", async () => {
    // Phase 1 of stream-json migration: /status is now translated (bot-side
    // handler) rather than hidden — it actually runs `cta status` and posts
    // the formatted output, instead of telling the user "go run it yourself."
    // Pointing CTA_BIN at /usr/bin/true gives a fast, deterministic exit-0
    // with empty stdout — enough to verify the wiring without a real cta.
    process.env.CTA_BIN = "/usr/bin/true";
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/status", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    // Header line names the underlying command so the user knows what they're
    // reading.
    expect(sent[0].text).toContain("cta status");
    delete process.env.CTA_BIN;
  });

  test("/agents is intercepted with TUI-only message", async () => {
    // /clear and /model now have their own handlers; /agents stays a
    // TUI-only intercept.
    pair({ chat_id: -1001, user_id: 99 });
    for (const cmd of ["/agents"]) {
      sent.length = 0;
      const handled = await poller.tryHandleCommand(
        msg({ text: cmd, chat_id: -1001, from_id: 99 }),
      );
      expect(handled).toBe(true);
      expect(sent.length).toBe(1);
    }
  });

  test("unknown /skill (not blocklisted) falls through to claude", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/qa run smoke", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(false); // claude dispatches
    expect(sent.length).toBe(0); // no bot reply
  });

  test("@-suffixed built-in (/status@MyBot) is still intercepted", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/status@MyBot", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
  });

  test("/model (no arg) shows the current model for the topic", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/model", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    // Real command now (not a hidden "edit .env" reason).
    expect(sent[0].text.toLowerCase()).toContain("model for this topic");
  });

  test("/agents surfaces the agents-specific reason", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/agents", chat_id: -1001, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain(".claude/agents");
  });
});

describe("/clear (D14 — TUI command translated, not delegated)", () => {
  // /clear in claude TUI is caught by the TUI layer, never reaches the model
  // — so forwarding it via send-keys would clear claude's context but never
  // produce a send_telegram reply, leaving the user staring at the typing-
  // keepalive indicator until its 10-minute hard cap. We own the semantic:
  // rotate the per-topic session UUID, kill the tmux session, ack the user.
  // The watchdog (kick_dead_topic_sessions) respawns the topic with the
  // new UUID → fresh claude session.

  function pair(opts?: { chat_id?: number; user_id?: number }): void {
    const state: poller.PairedState = {
      version: 1,
      chat_id: opts?.chat_id ?? -1001,
      user_id: opts?.user_id ?? 99,
      paired_at: new Date().toISOString(),
    };
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify(state, null, 2));
    poller.refreshPairedIfChanged();
  }

  function seedMount(args: {
    thread_id: number | "dm";
    tmux_session?: string;
  }): void {
    const tid = args.thread_id;
    const mount = {
      channel: "telegram",
      thread_id: tid,
      path: STATE,
      label: "test",
      session_id: "test-session-id",
      tmux_session: args.tmux_session ?? (typeof tid === "number" ? `topic-${tid}` : "topic-dm"),
      created_at: new Date().toISOString(),
    };
    writeFileSync(MOUNTS_JSON, JSON.stringify({ version: 2, mounts: [mount] }, null, 2));
    poller.refreshMountsIfChanged();
  }

  function seedSessionUuid(thread_id: number | "dm", uuid: string): string {
    const sessDir = join(STATE, "sessions");
    mkdirSync(sessDir, { recursive: true });
    const path = join(sessDir, String(thread_id));
    writeFileSync(path, uuid + "\n");
    return path;
  }

  beforeEach(() => { sent.length = 0; });

  test("/clear on real mount: rotates session UUID + acks", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    seedMount({ thread_id: 42 });
    const sessionFile = seedSessionUuid(42, "old-uuid-aaaa");

    const handled = await poller.tryHandleCommand(
      msg({ text: "/clear", chat_id: -1001, thread_id: 42, from_id: 99 }),
    );
    expect(handled).toBe(true);

    // UUID must be rotated to something other than "old-uuid-aaaa".
    const newContent = readFileSync(sessionFile, "utf8").trim();
    expect(newContent.length).toBeGreaterThan(0);
    expect(newContent).not.toBe("old-uuid-aaaa");

    // Ack reply explains what happened.
    expect(sent.length).toBe(1);
    expect(sent[0].text.toLowerCase()).toMatch(/clear|new session/);
    expect(sent[0].chat_id).toBe(-1001);
    expect(sent[0].message_thread_id).toBe(42);
  });

  test("/clear on unmounted topic: friendly nothing-to-clear reply", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    // No seedMount — topic 7777 is unmounted.

    const handled = await poller.tryHandleCommand(
      msg({ text: "/clear", chat_id: -1001, thread_id: 7777, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text.toLowerCase()).toMatch(/nothing|not mounted|no mount/);
  });

  test("/clear from a non-paired user is silently dropped (no reply, no rotation)", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    seedMount({ thread_id: 42 });
    const sessionFile = seedSessionUuid(42, "owner-only-uuid");

    const handled = await poller.tryHandleCommand(
      msg({ text: "/clear", chat_id: -1001, thread_id: 42, from_id: 8888 }), // wrong user
    );
    expect(handled).toBe(true); // consumed so claude doesn't see it
    expect(sent.length).toBe(0); // no reply leak
    expect(readFileSync(sessionFile, "utf8").trim()).toBe("owner-only-uuid"); // unchanged
  });
});

describe("effortArg — auto sentinel maps to omit --effort", () => {
  test("auto → undefined (omit the flag → claude uses its own default)", () => {
    expect(poller.effortArg("auto")).toBeUndefined();
  });
  test("real levels pass through unchanged", () => {
    expect(poller.effortArg("low")).toBe("low");
    expect(poller.effortArg("medium")).toBe("medium");
    expect(poller.effortArg("high")).toBe("high");
    expect(poller.effortArg("xhigh")).toBe("xhigh");
    expect(poller.effortArg("max")).toBe("max");
  });
});

// ─── Phase 1: bot-side slash command intercept ──────────────────────────────
// /cost, /usage, /restart all run server-side instead of relaying claude TUI
// output via the picker-watcher Format A/B parser (deleted in this phase).
// See agent/poller/slash-commands.ts for the pure helpers; these tests cover
// the poller wiring through tryHandleCommand → TUI_COMMANDS["translated"].

describe("/cost (Phase 1 — JSONL token aggregation)", () => {
  function pair(opts?: { chat_id?: number; user_id?: number }): void {
    const state: poller.PairedState = {
      version: 1,
      chat_id: opts?.chat_id ?? -1001,
      user_id: opts?.user_id ?? 99,
      paired_at: new Date().toISOString(),
    };
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify(state, null, 2));
    poller.refreshPairedIfChanged();
  }

  function seedMount(thread_id: number | "dm", projectPath: string): void {
    const mount = {
      channel: "telegram",
      thread_id,
      path: projectPath,
      label: "test",
      session_id: "test-session-id",
      tmux_session: typeof thread_id === "number" ? `topic-${thread_id}` : "topic-dm",
      created_at: new Date().toISOString(),
    };
    writeFileSync(MOUNTS_JSON, JSON.stringify({ version: 2, mounts: [mount] }, null, 2));
    poller.refreshMountsIfChanged();
  }

  function seedSessionUuid(thread_id: number | "dm", uuid: string): void {
    const sessDir = join(STATE, "sessions");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, String(thread_id)), uuid + "\n");
  }

  /**
   * Plant a JSONL transcript under a fake $HOME. handleCost resolves the path
   * via ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl, so we redirect HOME
   * for the duration of one test.
   */
  function seedJsonl(homeDir: string, projectPath: string, uuid: string, entries: unknown[]): void {
    const encoded = projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
    const dir = join(homeDir, ".claude/projects", encoded);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  beforeEach(() => { sent.length = 0; });

  test("/cost on a mounted topic reports session totals from JSONL", async () => {
    const tmpHome = join(STATE, "fakehome");
    mkdirSync(tmpHome, { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      pair({ chat_id: -1001, user_id: 99 });
      const projectPath = join(STATE, "iron-flow");
      mkdirSync(projectPath, { recursive: true });
      seedMount(42, projectPath);
      seedSessionUuid(42, "uuid-abc");
      seedJsonl(tmpHome, projectPath, "uuid-abc", [
        { type: "user", message: { content: "hi" } },
        {
          type: "assistant",
          message: {
            model: "claude-opus-4-7",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      ]);

      const handled = await poller.tryHandleCommand(
        msg({ text: "/cost", chat_id: -1001, thread_id: 42, from_id: 99 }),
      );
      expect(handled).toBe(true);
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("Session cost");
      expect(sent[0].text).toContain("claude-opus-4-7");
    } finally {
      process.env.HOME = origHome;
    }
  });

  test("/cost on unmounted topic: friendly hint, no JSONL read", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/cost", chat_id: -1001, thread_id: 9999, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text.toLowerCase()).toMatch(/no mount|nothing to bill/);
  });

  test("/cost before any claude turn (no session UUID): tells user to send a message first", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    seedMount(42, STATE);
    // no seedSessionUuid → handleCost hits the "session not started" branch

    const handled = await poller.tryHandleCommand(
      msg({ text: "/cost", chat_id: -1001, thread_id: 42, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text.toLowerCase()).toContain("send any message");
  });
});

describe("/restart (Phase 1)", () => {
  function pair(opts?: { chat_id?: number; user_id?: number }): void {
    const state: poller.PairedState = {
      version: 1,
      chat_id: opts?.chat_id ?? -1001,
      user_id: opts?.user_id ?? 99,
      paired_at: new Date().toISOString(),
    };
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify(state, null, 2));
    poller.refreshPairedIfChanged();
  }

  beforeEach(() => { sent.length = 0; });

  test("/restart on unmounted topic: friendly hint", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const handled = await poller.tryHandleCommand(
      msg({ text: "/restart", chat_id: -1001, thread_id: 12345, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text.toLowerCase()).toMatch(/no mount|nothing to restart/);
  });

  test("/restart on mounted topic: acks + (best-effort) kills tmux", async () => {
    pair({ chat_id: -1001, user_id: 99 });
    const mount = {
      channel: "telegram",
      thread_id: 42,
      path: STATE,
      label: "test",
      session_id: "test-session-id",
      tmux_session: "topic-42",
      created_at: new Date().toISOString(),
    };
    writeFileSync(MOUNTS_JSON, JSON.stringify({ version: 2, mounts: [mount] }, null, 2));
    poller.refreshMountsIfChanged();

    const handled = await poller.tryHandleCommand(
      msg({ text: "/restart", chat_id: -1001, thread_id: 42, from_id: 99 }),
    );
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    // tmux kill-session is no-op when nothing's running, but the ack reply
    // must always go out so the user knows the command landed.
    expect(sent[0].text.toLowerCase()).toContain("restart");
  });
});

describe("/usage (Phase 1)", () => {
  function pair(opts?: { chat_id?: number; user_id?: number }): void {
    const state: poller.PairedState = {
      version: 1,
      chat_id: opts?.chat_id ?? -1001,
      user_id: opts?.user_id ?? 99,
      paired_at: new Date().toISOString(),
    };
    writeFileSync(PAIRED_STATE_FILE, JSON.stringify(state, null, 2));
    poller.refreshPairedIfChanged();
  }

  beforeEach(() => { sent.length = 0; });

  test("/usage without credentials: graceful error", async () => {
    // Redirect HOME to a clean tmpdir so the real ~/.claude/.credentials.json
    // isn't found; on macOS keychain may still succeed, so we accept either
    // a "couldn't find credentials" message OR a successful 401-style reply
    // from a real keychain hit — both prove handleUsage didn't crash.
    const tmpHome = join(STATE, "fakehome-usage");
    mkdirSync(tmpHome, { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      pair({ chat_id: -1001, user_id: 99 });
      const handled = await poller.tryHandleCommand(
        msg({ text: "/usage", chat_id: -1001, from_id: 99 }),
      );
      expect(handled).toBe(true);
      expect(sent.length).toBe(1);
      // Either "couldn't find" (no creds) or "Anthropic usage" / "Couldn't fetch"
      // (creds resolved but API didn't validate) — both prove the handler ran.
      const text = sent[0].text;
      const isExpectedShape =
        text.toLowerCase().includes("couldn't") ||
        text.includes("Anthropic usage");
      expect(isExpectedShape).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });
});
