/**
 * Telegram outbound wire — the Bot API egress, extracted from poller.ts in
 * Phase 1 of the ChatTransport migration.
 *
 * Scope (P1): the full Bot API WIRE — outbound egress (send/react/typing/
 * button/edit/answer) AND inbound fetch (getUpdates/getMe) + the raw Tg* wire
 * types. Still NO ChatTransport interface and NO inbound normalization: the
 * poller keeps driving the long-poll loop and consumes raw TgUpdate. P2 wraps
 * this in `class TelegramTransport implements ChatTransport`, owns the loop,
 * and normalizes TgUpdate → InboundEvent (types.ts) — at which point the raw
 * Tg* types stop leaking into the poller.
 *
 * Design rules this file obeys:
 *   - Pure functions; reads env LAZILY (TELEGRAM_BOT_TOKEN / TELEGRAM_API_BASE)
 *     so importing it for tests needs no real token, and tests can repoint
 *     egress at a mock server by setting TELEGRAM_API_BASE before first call.
 *   - NO imports from poller.ts → no import cycle (poller imports THIS, never
 *     the reverse). The adapter knows how to talk to Telegram; it holds no
 *     product policy.
 *   - Policy stays in the poller: whether to ack and with which glyph
 *     (access.json), the typing keepalive loop, the long-poll offset cursor.
 *     This file is the dumb wire those policies drive.
 *
 * Log strings are preserved verbatim from the poller originals ("poller: …
 * failed") so this extraction is a zero-observable-change refactor.
 */

/**
 * Bot API base URL. Tests set TELEGRAM_API_BASE to a local mock server; prod
 * builds the canonical `https://api.telegram.org/bot<token>` form. Read lazily
 * on every call so the env override applies regardless of import order.
 */
export function getApiBase(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN must be set");
  return process.env.TELEGRAM_API_BASE ?? `https://api.telegram.org/bot${token}`;
}

function outboundTimeoutMs(): number {
  const n = Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS ?? "15000");
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/**
 * Send plain text to a chat (and optional forum topic). Best-effort: a failed
 * send is logged, never thrown — the poller's hot path must not unwind on a
 * transient Bot API hiccup. (Was poller `reply()`.)
 */
export async function sendText(
  target: { chat_id: number | string; thread_id?: number },
  text: string,
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: target.chat_id, text };
  if (target.thread_id != null) body.message_thread_id = target.thread_id;
  try {
    const resp = await fetchWithTimeout(`${getApiBase()}/sendMessage`, outboundTimeoutMs(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      process.stderr.write(`poller: reply failed: ${json.description ?? "(no description)"}\n`);
    }
  } catch (e) {
    process.stderr.write(`poller: reply fetch failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * Set a single reaction on a message. The wire shared by both ack stages —
 * the *policy* (whether to react, and the delivered vs. read glyph) lives in
 * the poller, which passes the chosen emoji here. Telegram limits a bot to one
 * reaction per message, so this replaces rather than stacks. ok:false (invalid
 * emoji on the free-bot whitelist) is swallowed: the operator picks the glyph
 * in Pager and a rejected one just no-ops.
 */
export async function setReaction(chat_id: number, message_id: number, emoji: string): Promise<void> {
  try {
    await fetchWithTimeout(`${getApiBase()}/setMessageReaction`, outboundTimeoutMs(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        message_id,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
  } catch (e) {
    process.stderr.write(`poller: setMessageReaction failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * Fire a "typing…" chat action. Telegram auto-clears it after ~5s; the poller's
 * keepalive loop re-fires it. (Was the body of poller `sendTyping()`.)
 */
export async function sendChatAction(chat_id: number, thread_id?: number): Promise<void> {
  const body: Record<string, unknown> = { chat_id, action: "typing" };
  if (thread_id != null) body.message_thread_id = thread_id;
  try {
    await fetchWithTimeout(`${getApiBase()}/sendChatAction`, outboundTimeoutMs(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    process.stderr.write(`poller: sendChatAction failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export interface BotCommand {
  command: string;     // without the leading slash, 1-32 chars, lowercase
  description: string; // 1-256 chars
}

/**
 * Register the bot's command list (the "/" autocomplete menu Telegram shows)
 * via setMyCommands. Default scope — these are static command names + English
 * descriptions, not user data, so global scope is fine for a single-operator
 * bot. Best-effort: a failed call just means no "/" menu, not a delivery loss.
 */
export async function setMyCommands(commands: BotCommand[]): Promise<void> {
  try {
    // fetchWithTimeout (not bare fetch): this is awaited at boot BEFORE the
    // poll loop starts, so a half-open connection to api.telegram.org would
    // wedge the poller before getUpdates. Same 15s guard getMe uses.
    await fetchWithTimeout(`${getApiBase()}/setMyCommands`, 15_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
  } catch (e) {
    process.stderr.write(`poller: setMyCommands failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * Edit a sent message's text in-place. Omitting reply_markup also drops any
 * inline keyboard on the original — one call covers "append the user's choice
 * + remove the buttons" for an answered button prompt. Best-effort: a failed
 * edit leaves a stale button, not a delivery loss.
 */
export async function editMessageText(
  chat_id: number,
  message_id: number,
  text: string,
): Promise<void> {
  try {
    await fetchWithTimeout(`${getApiBase()}/editMessageText`, outboundTimeoutMs(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, message_id, text }),
    });
  } catch (e) {
    process.stderr.write(`poller: editMessageText failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * Send a message carrying an inline keyboard. Returns the sent message's ref
 * so the caller can later edit it (e.g. to record the chosen button), or null
 * on failure.
 */
export async function sendInlineKeyboard(
  chat_id: number,
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
  thread_id?: number,
): Promise<{ message_id: number } | null> {
  try {
    const body: Record<string, unknown> = { chat_id, text, reply_markup: { inline_keyboard: buttons } };
    // Forum topics: without message_thread_id the keyboard lands in General
    // instead of the topic. (mcp-telegram set this from THREAD_ID; P4 moves
    // that responsibility into the transport.)
    if (thread_id != null) body.message_thread_id = thread_id;
    const resp = await fetchWithTimeout(`${getApiBase()}/sendMessage`, outboundTimeoutMs(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!json.ok) {
      process.stderr.write(`poller: sendInlineKeyboard failed: ${json.description}\n`);
      return null;
    }
    return json.result ?? null;
  } catch (e) {
    process.stderr.write(`poller: sendInlineKeyboard fetch failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/**
 * Acknowledge a callback query (button tap) so Telegram stops the client-side
 * spinner. Optional toast text / alert. Best-effort.
 */
export async function answerCallback(callback_query_id: string, text?: string, alert?: boolean): Promise<void> {
  try {
    await fetchWithTimeout(`${getApiBase()}/answerCallbackQuery`, outboundTimeoutMs(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id, text, show_alert: alert ?? false }),
    });
  } catch (e) {
    process.stderr.write(`poller: answerCallback failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// ─── inbound wire ──────────────────────────────────────────────────────────
// Raw Telegram update shapes + the long-poll fetch. The poller still drives
// the loop and consumes TgUpdate directly (P1); P2's TelegramTransport will
// own the loop and normalize these into the platform-agnostic InboundEvent.

export interface TgUser { id: number; }
export interface TgChat { id: number; }
export interface TgForumTopicCreated { name: string; icon_color?: number; icon_custom_emoji_id?: string; }
export interface TgForumTopicEdited { name?: string; icon_custom_emoji_id?: string; }
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  // Service messages carrying forum topic lifecycle events. Telegram emits
  // these inside the topic itself (message_thread_id is the new topic id) when
  // a topic is created or renamed. There's no Bot API getForumTopic, so this
  // is the *only* way to learn topic names — meaning we can only know about
  // topics created / renamed *after* the bot joined the group.
  forum_topic_created?: TgForumTopicCreated;
  forum_topic_edited?: TgForumTopicEdited;
}
export interface TgChatMemberUpdated {
  chat: { id: number; title?: string };
  from: { id: number; first_name?: string; username?: string };
  new_chat_member: { user: { id: number; is_bot: boolean }; status: string };
  old_chat_member: { user: { id: number; is_bot: boolean }; status: string };
}
export interface TgCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: { chat: { id: number }; message_id: number; message_thread_id?: number; text?: string };
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
  callback_query?: TgCallbackQuery;
}
export interface TgResp { ok: boolean; result?: TgUpdate[]; description?: string; }

/**
 * fetch with a hard client-side timeout. Telegram long-poll only sets a
 * SERVER-side timeout; without a client abort, a half-open/stalled TCP
 * connection (Wi-Fi flap, NAT drop) makes `await fetch` hang forever and
 * wedges the poll loop — alive but stuck, heartbeat frozen. AbortController
 * bounds it so the call throws and the loop's retry path recovers.
 *
 * Generic (not Telegram-specific) and used by every inbound/outbound Bot API
 * request so a half-open socket cannot wedge dispatch or typing forever.
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Forward an external abort (e.g. host wake-event → poller interrupts the
  // long-poll to force-refresh the socket) into our own controller so the
  // pending fetch unblocks. We attach manually instead of using AbortSignal.any
  // for portability across bun/node versions; the cleanup in finally removes
  // the listener so a long-lived externalSignal can't leak references to dead
  // controllers across many poll cycles.
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      ctrl.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Long-poll one batch of updates. `timeoutSec` is the server long-poll window —
 * the poller owns the poll cadence and passes it in; the client abort budget is
 * that window + 15s slack so a stalled connection throws here instead of hanging
 * the loop. Throws on ok:false so the caller's retry path recovers.
 * allowed_updates is sent every call (Telegram drops my_chat_member /
 * callback_query otherwise on a fresh deploy — no server-side state assumed).
 */
export async function getUpdates(
  offset: number,
  timeoutSec: number,
  externalSignal?: AbortSignal,
): Promise<TgUpdate[]> {
  const allowed = encodeURIComponent(JSON.stringify([
    "message", "edited_message", "my_chat_member", "callback_query",
  ]));
  const url = `${getApiBase()}/getUpdates?timeout=${timeoutSec}&offset=${offset}&allowed_updates=${allowed}`;
  const resp = await fetchWithTimeout(url, (timeoutSec + 15) * 1000, undefined, externalSignal);
  const json = (await resp.json()) as TgResp;
  if (!json.ok) {
    throw new Error(`getUpdates: ${json.description ?? "(no description)"}`);
  }
  return json.result ?? [];
}

/**
 * Fetch the bot's own identity (getMe), with a 15s client timeout. Pure wire:
 * returns the parsed Bot API response and lets errors propagate. The poller's
 * preflight owns the policy (capture bot id, exit on a rejected token,
 * warn-and-continue on a transient network failure).
 */
export async function getMe(): Promise<{ ok: boolean; result?: { id?: number; username?: string }; description?: string }> {
  const resp = await fetchWithTimeout(`${getApiBase()}/getMe`, 15_000);
  return (await resp.json()) as { ok: boolean; result?: { id?: number; username?: string }; description?: string };
}
