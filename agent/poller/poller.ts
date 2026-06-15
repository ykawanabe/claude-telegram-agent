#!/usr/bin/env bun
/**
 * poller — single-instance Telegram long-poll loop.
 *
 * Replaces the official plugin's inbound side. The bot has exactly one
 * `getUpdates` consumer (per the Bot API's 409 Conflict rule — concurrent
 * pollers race and silently drop messages). We fan out by `message_thread_id`
 * to per-topic tmux sessions running `claude`.
 *
 * Phase 1 (MVP) carries a hardcoded routing table:
 *   - HARDCODED_THREAD_ID → tmux session `topic-<id>`
 *   - everything else → silently dropped
 * Phase 2 replaces this with mounts.json lookup.
 *
 * Dispatch primitive: `tmux load-buffer` + `paste-buffer -d` + `send-keys Enter`.
 * Settled in eng review (2026-05-13) over send-keys-with-Enter-separators
 * because paste-buffer survives multiline, code blocks, emoji, and quotes
 * without any shell-escaping. The trailing send-keys Enter is the prompt
 * submit; literal newlines in the payload remain literal newlines.
 *
 * Offset persistence: atomic tempfile + fsync + rename, written BEFORE
 * dispatching the batch. Crash-during-dispatch then drops the batch on
 * restart rather than re-delivering it (less surprising for the user than
 * doubled messages).
 *
 * Heartbeat: touches $STATE_DIR/heartbeat-poller every loop
 * iteration so the watchdog can detect a hung poller.
 */
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { addMount, mountKey, readMounts, type Mount, type ThreadId } from "../mount-store/mount-store";
import {
  aggregateCostFromJsonl,
  contextWindowFor,
  fetchUsageStats,
  formatCostMessage,
  formatUsageMessage,
  jsonlPathForSession,
  lastContextFromJsonl,
  resolveCredentialToken,
} from "./slash-commands";
import { ClaudeDaemonRegistry } from "./claude-daemon-registry";
import type { ClaudeDaemonOptions } from "./claude-daemon";
import { parseButtonsMarker } from "./buttons-marker";
import {
  type HeartbeatState,
  markFiredToday,
  readState as readHeartbeatState,
  writeState as writeHeartbeatState,
} from "./heartbeat-checks/heartbeat-state";
import { detectMissedTaskFire, shouldFireTask } from "./heartbeat-checks/scheduler";
import { readTasks, removeTask, setTaskEnabled, type ScheduledTask } from "../tasks-store/tasks-store";
import { tasksJson, taskRunDir } from "../lib/paths";
// Agentic 秘書 mode — gated executor + approval round-trip. The engine (policy,
// approval store, gate hook, runner) lives under ./agentic; the poller wires the
// Telegram surface (cards, buttons, /do, proactive routing) here.
import { runAgentic, defaultHookScriptPath, isSessionUnusableError } from "./agentic/agentic-runner";
import {
  listRequests, readRequest, writeDecision, markSent, cleanup as cleanupApproval,
  type ApprovalRequest,
} from "./agentic/approval-store";
import { renderApprovalCard, approvalButtonRows, parseApprovalCallback, applyEdit } from "./agentic/cards";
// Telegram outbound wire (Bot API egress), extracted in P1 of the ChatTransport
// migration. `reply` is the adapter's `sendText` (same signature, 58 call sites
// unchanged). The poller keeps the *policy* — ack on/off + glyph, typing
// keepalive, offset — and drives this dumb wire. See ../channels/telegram/adapter.ts.
import {
  sendInlineKeyboard,
  answerCallback,
  getUpdates,
  getMe,
  setMyCommands,
} from "../channels/telegram/adapter";
// Raw Telegram inbound wire types. After the normalized-event migration the
// poller consumes these only at the genuinely-Telegram-only edges reached via
// `ev.raw`: membership status transitions (handleMyChatMember) and the
// callback_query id/prompt (onButtonPress). TgMessage is re-exported for tests.
import type {
  TgMessage,
  TgUpdate,
  TgChatMemberUpdated,
} from "../channels/telegram/adapter";
import { makeTransport } from "../channels/transport-factory";
import { isButtonCapable, isEditable, isInterruptible, isReactable, isTyping, type AckHandle, type ChatAddress, type ChatTransport, type Channel, type InboundEvent } from "../channels/types";

/** The normalized message-kind event the command pipeline consumes (replaces the
 *  raw TgMessage every handler used to take). Carries everything a handler needs
 *  — address (reply target), routingKey (mount/registry key), from.id (auth),
 *  text, messageRef (ack target) — with the original update still on `.raw`. */
type InboundMessageEvent = Extract<InboundEvent, { kind: "message" }>;
/** The normalized button-press event (an inline-keyboard tap). Carries the tapped
 *  callback payload as `label`, plus the same address/routingKey/from/messageRef a
 *  message event does. Telegram-only callback mechanics (answerCallback's query id,
 *  the prompt message's text for the inline "↳ choice" echo) are reached via `raw`. */
type ButtonPressEvent = Extract<InboundEvent, { kind: "button-press" }>;

/** Routing key → mount-store ThreadId. Telegram emits "dm" or a numeric string;
 *  a future platform's opaque slug stays a string (Phase 2 relaxes the consumers
 *  to accept it). */
function threadIdOf(ev: InboundMessageEvent): number | "dm" {
  return ev.routingKey === "dm" ? "dm" : Number(ev.routingKey);
}

/** Numeric Telegram chat id from the normalized address. The poller is the
 *  Telegram adapter's consumer; a non-Telegram address here is a bug. */
function chatIdOf(ev: InboundMessageEvent): number {
  if (ev.address.channel !== "telegram") throw new Error(`poller: non-telegram address (${ev.address.channel})`);
  return ev.address.chatId;
}

// ─── ChatTransport (P3 — DI'd) ───────────────────────────────────────────────
// The poller drives ALL inbound + outbound through the ChatTransport interface,
// never the wire adapter directly. One instance per process (a poller serves one
// platform — single getUpdates consumer). `transport` is typed as the
// platform-agnostic ChatTransport; optional capabilities (edit / react / typing /
// buttons) are reached only behind capability guards (isEditable/isReactable/
// isTyping/isButtonCapable), so a future platform that lacks one degrades
// gracefully rather than failing to compile or crashing at runtime.
//
// Selected by CTA_CHANNEL via the transport-factory DI seam (default "telegram").
// Phase 0: only Telegram is registered in the factory; CTA_CHANNEL unset →
// "telegram", so production is unchanged.
const activeChannel: Channel = (process.env.CTA_CHANNEL as Channel) ?? "telegram";
const transport: ChatTransport = makeTransport(activeChannel);

/** Outbound plain text. Flows through transport.sendText (which chunks >4096 and
 *  returns a ref). Takes a platform-agnostic ChatAddress — the poller no longer
 *  builds a Telegram-shaped target, so a non-Telegram transport replies through
 *  the identical path. Handlers pass the inbound event's `ev.address`; the few
 *  non-inbound senders (daemon stream, mount prompt) build one via `tgAddr`. */
async function reply(to: ChatAddress, text: string): Promise<void> {
  await transport.sendText({ to, text });
}

/** Build a Telegram ChatAddress from raw ids. Transitional helper for the
 *  outbound seam (Phase 1 chunk 1): handlers still hold a raw TgMessage, and the
 *  daemon/stream callbacks resolve a numeric chat id. Once the command pipeline
 *  consumes the normalized event (chunk 3) most call sites collapse to
 *  `ev.address` and this remains only for the daemon-stream senders. */
function tgAddr(chatId: number, threadId?: number): ChatAddress {
  return { channel: "telegram", chatId, threadId };
}

/** Edit a sent message's text in place — now via transport.editText (Editable). */
async function editMessageText(chat_id: number, message_id: number, text: string): Promise<void> {
  if (isEditable(transport)) {
    await transport.editText({ channel: "telegram", chatId: chat_id, messageId: message_id }, text);
  }
}

// Poller-side cache key for Telegram updates. Hardcoded "telegram" because
// this file is the Telegram adapter; the LINE adapter (when added) will
// build keys with "line" instead.
function tgKey(thread_id: ThreadId): string {
  return mountKey("telegram", thread_id);
}
import { stateDir, pollerOffsetFile, heartbeatFile, mountsJson, pairingCodeFile, pairedStateFile, topicsJson, sessionsDir, installAgentDir, installMountStoreTs, settingsJson, wakeFlagFile } from "../lib/paths";
import { runFileAccessProbe } from "./file-access-probe";

// ─── env ─────────────────────────────────────────────────────────────────────

// Env reads happen lazily so importing this module for tests doesn't require
// a real bot token. Tests override CTA_STATE_DIR to redirect state files
// and TELEGRAM_API_BASE to route outbound calls at a mock server.

const ENV_MAIN_CHAT_ID = process.env.MAIN_CHAT_ID; // optional Phase 2 override
const POLL_TIMEOUT_SEC = Number(process.env.POLL_TIMEOUT_SEC ?? "25");

const STATE_DIR = stateDir();
const OFFSET_FILE = pollerOffsetFile();
const HEARTBEAT_FILE = heartbeatFile();
const MOUNTS_JSON = mountsJson();
const PAIRING_CODE_FILE = pairingCodeFile();
const PAIRED_STATE_FILE = pairedStateFile();
const SETTINGS_FILE = settingsJson();
const WAKE_FLAG = wakeFlagFile();
// Topic-name cache: poller writes, Pager reads. Updated when we see a
// forum_topic_created / forum_topic_edited service message fly past. Key is
// "<chat_id>/<message_thread_id>" so multi-chat installs don't collide on
// numeric thread ids.
const TOPICS_JSON = topicsJson();

// ─── offset persistence ──────────────────────────────────────────────────────

/**
 * Read the last persisted update offset, or 0 if missing/corrupt. The Bot
 * API treats `offset` as "the smallest unseen update id minus 1" — passing
 * 0 means "from the beginning of the queue" (whatever's still in the 24h
 * server-side retention). Acceptable on fresh install.
 */
function readOffset(): number {
  try {
    const raw = readFileSync(OFFSET_FILE, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Atomic offset write: tempfile + fsync + rename. fsync forces the kernel
 * to flush the data before the rename publishes it. Without fsync, a sleep
 * or power loss mid-write can leave us with a partially-written tempfile
 * AND a successful rename of an empty file. Belt-and-suspenders.
 */
function writeOffset(value: number): void {
  const tmp = `${OFFSET_FILE}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${value}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, OFFSET_FILE);
}

function touchHeartbeat(): void {
  if (!existsSync(HEARTBEAT_FILE)) {
    const fd = openSync(HEARTBEAT_FILE, "w", 0o600);
    closeSync(fd);
  }
  const now = new Date();
  utimesSync(HEARTBEAT_FILE, now, now);
}

// ─── paired state ────────────────────────────────────────────────────────────
// Phase 3 zero-config onboarding: instead of MAIN_CHAT_ID in .env, the user
// pairs the bot in-chat by sending `/pair <code>`. The poller writes the
// resulting chat_id + user_id to paired.json. MAIN_CHAT_ID env (Phase 2
// holdover) is honored as a fallback for users upgrading from the manual
// flow — paired.json wins if both exist.

interface PairedState {
  version: 1;
  chat_id: number;
  user_id: number;
  paired_at: string;
  chat_title?: string;
}

let pairedCache: PairedState | null = null;
let pairedMtimeMs = 0;

// Idle-daemon-eviction threshold (minutes; 0 = disabled), live-reloaded from
// settings.json each poll loop. 0 unless the operator opts in via
// `cta config idle-evict <min>` (the Pager "Memory" toggle).
let idleEvictMinutes = 0;
// Mid-turn auto-steer: when a message arrives during an in-flight turn, the
// registry debounces then gracefully interrupts so the batched messages flow
// into the next turn. Default ON; operator opt-out via
// `cta config interrupt-steer off` (the Pager steering toggle). Live-reloaded
// from settings.json each poll loop, same path as idle_evict_minutes.
let interruptOnMessage = true;
// H2 daily digest settings — live-reloaded from settings.json, same gating as
// the other fields. `digestTime` defaults to "09:00", `digestTimezone`
// defaults to the system TZ (Intl resolved at process start), `digestQuietHours`
// absent → no quiet window. Operator writes via `cta config digest-time` /
// `cta config quiet-hours` / `cta config timezone`.
let digestTime = "09:00";
let digestTimezone = ((): string => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
let digestQuietHours: { start: string; end: string } | null = null;
// Agentic-runner model — live-reloaded from settings.json (`agenticModel`).
// Unset → no --model flag → claude's default (Opus tier). The proactive
// secretary is the expensive daily path (~$1.1-1.4/run on the default), so the
// operator can pin a cheaper model via `cta config agentic-model sonnet`.
// Applies to BOTH the daily secretary fire and /do (same launchAgentic path).
let agenticModel: string | undefined = undefined;
// Reasoning-effort for the agentic runner (`--effort low|medium|high|xhigh|max`).
// Unset → claude's default, which inherits the user's settings.json effortLevel
// (currently xhigh) — pin lower via `cta config agentic-effort medium` to cut
// scheduled-run cost without changing interactive sessions.
let agenticEffort: string | undefined = undefined;
// Scheduled-task scheduler state. Loaded from disk on poller boot (the
// `firedToday` map survives restarts so we never fire twice on the same
// local-tz day, even if the poller relaunches mid-day). Mutated in
// taskDispatch and persisted BEFORE the runner spawns (write-through — a
// crash during fire counts as "fired today" so we don't retry on next tick).
let heartbeatState: HeartbeatState = { version: 1, firedToday: {} };
let settingsMtimeMs = 0;
// Idle-clear tuning. When an idle topic's transcript exceeds this many bytes,
// the idle sweep flushes durable memory then rotates the session UUID (a real
// /clear, resets cost) instead of merely evicting (which keeps the bloated
// session). Below the threshold → evict only (RAM reclaim, no context loss).
const IDLE_CLEAR_MIN_BYTES = ((): number => {
  const n = Number(process.env.IDLE_CLEAR_MIN_BYTES);
  return Number.isFinite(n) && n >= 0 ? n : 1024 * 1024; // 1 MB; malformed/unset env → default
})();
// Hard cap on the memory-flush turn before abandoning it (and leaving the
// session intact). The flush runs on a bloated session so it can be slow.
const IDLE_FLUSH_TIMEOUT_MS = ((): number => {
  const n = Number(process.env.IDLE_FLUSH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3 * 60_000; // malformed/unset env → default
})();
// Topics with an in-flight idle flush, so the sweep doesn't launch a second.
const idleFlushing = new Set<string>();
// Epoch ms of the last file-access (FDA) probe; throttles re-probing to ~60s.
let lastFileAccessProbe = 0;

function refreshPairedIfChanged(): void {
  let mtimeMs = 0;
  try { mtimeMs = statSync(PAIRED_STATE_FILE).mtimeMs; } catch { /* missing */ }
  if (mtimeMs === pairedMtimeMs) return;
  try {
    if (mtimeMs === 0) {
      pairedCache = null;
    } else {
      const raw = readFileSync(PAIRED_STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as PairedState;
      if (parsed.version !== 1) throw new Error("paired.json: unknown version");
      pairedCache = parsed;
    }
    pairedMtimeMs = mtimeMs;
    process.stdout.write(`[${new Date().toISOString()}] paired state reloaded (${pairedCache ? `chat=${pairedCache.chat_id} user=${pairedCache.user_id}` : "unpaired"})\n`);
  } catch (e) {
    process.stderr.write(`poller: paired.json reload failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Live-reload the idle-eviction threshold from settings.json (mtime-gated,
 *  same pattern as refreshPairedIfChanged). Operator-written via
 *  `cta config idle-evict <min>` / the Pager Memory toggle; picked up on the
 *  next poll loop with no poller restart. Missing file, version mismatch, or
 *  any parse problem leaves the last good value in place; a present-but-zero
 *  value disables eviction. */
function refreshSettingsIfChanged(): void {
  let mtimeMs = 0;
  try { mtimeMs = statSync(SETTINGS_FILE).mtimeMs; } catch { /* missing → disabled below */ }
  if (mtimeMs === settingsMtimeMs) return;
  try {
    let next = 0;
    if (mtimeMs !== 0) {
      const raw = readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: number;
        idle_evict_minutes?: number;
        interrupt_on_message?: boolean;
        digestTime?: string;
        timezone?: string;
        quietHours?: { start?: string; end?: string };
        agenticModel?: string;
        agenticEffort?: string;
      };
      if (parsed.version !== 1) throw new Error("settings.json: unknown version");
      const n = Number(parsed.idle_evict_minutes ?? 0);
      next = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      const steer = parsed.interrupt_on_message;
      if (typeof steer === "boolean" && steer !== interruptOnMessage) {
        interruptOnMessage = steer;
        process.stdout.write(`[${new Date().toISOString()}] settings reloaded: interrupt_on_message=${interruptOnMessage}\n`);
      }
      // H2 digest settings — reload with logging on change so the operator
      // can see in agent.log when `cta config` writes took effect.
      if (typeof parsed.digestTime === "string" && parsed.digestTime !== digestTime) {
        digestTime = parsed.digestTime;
        process.stdout.write(`[${new Date().toISOString()}] settings reloaded: digestTime=${digestTime}\n`);
      }
      if (typeof parsed.timezone === "string" && parsed.timezone !== digestTimezone) {
        digestTimezone = parsed.timezone;
        process.stdout.write(`[${new Date().toISOString()}] settings reloaded: timezone=${digestTimezone}\n`);
      }
      const qh = parsed.quietHours;
      const nextQh = (qh && typeof qh.start === "string" && typeof qh.end === "string")
        ? { start: qh.start, end: qh.end }
        : null;
      const qhChanged = JSON.stringify(nextQh) !== JSON.stringify(digestQuietHours);
      if (qhChanged) {
        digestQuietHours = nextQh;
        process.stdout.write(`[${new Date().toISOString()}] settings reloaded: quietHours=${JSON.stringify(digestQuietHours)}\n`);
      }
      const nextModel = typeof parsed.agenticModel === "string" && parsed.agenticModel.trim() !== ""
        ? parsed.agenticModel.trim()
        : undefined;
      if (nextModel !== agenticModel) {
        agenticModel = nextModel;
        process.stdout.write(`[${new Date().toISOString()}] settings reloaded: agenticModel=${agenticModel ?? "(claude default)"}\n`);
      }
      const nextEffort = typeof parsed.agenticEffort === "string" && parsed.agenticEffort.trim() !== ""
        ? parsed.agenticEffort.trim()
        : undefined;
      if (nextEffort !== agenticEffort) {
        agenticEffort = nextEffort;
        process.stdout.write(`[${new Date().toISOString()}] settings reloaded: agenticEffort=${agenticEffort ?? "(claude default)"}\n`);
      }
    }
    settingsMtimeMs = mtimeMs;
    if (next !== idleEvictMinutes) {
      idleEvictMinutes = next;
      process.stdout.write(`[${new Date().toISOString()}] settings reloaded: idle_evict_minutes=${idleEvictMinutes}\n`);
    }
  } catch (e) {
    process.stderr.write(`poller: settings.json reload failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

function writePairedAtomic(state: PairedState): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${PAIRED_STATE_FILE}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, PAIRED_STATE_FILE);
}

function effectiveChatId(): string | null {
  if (pairedCache) return String(pairedCache.chat_id);
  if (ENV_MAIN_CHAT_ID) return ENV_MAIN_CHAT_ID;
  return null;
}

function effectiveUserId(): number | null {
  return pairedCache?.user_id ?? null;
}

// ─── outbound reply ──────────────────────────────────────────────────────────
// Direct Bot API call for command replies. Separate from mcp-telegram, which
// is per-topic and only reachable from claude. The poller needs its own
// outbound for `/pair`/`/mount` confirmations — no claude in the loop.

// ─── 2-stage reaction ack (👀 delivered → 👌 read) ───────────────────────────
// Owned by the ChatTransport (Reactable). setDeliveredAck reads the operator
// glyph (access.json) and sets 👀, returning a handle — or null if the operator
// disabled the glyph; setReadAcks flips queued handles to 👌. Telegram allows
// one reaction per bot per message, so the read REPLACES the delivered glyph
// (swap, not stack — capabilities.ackMechanism = "reaction-swap").
//
// N:1 fan-in: one daemon flush drains the whole per-topic queue, flipping every
// message dispatched in that debounce window at once.
//
// (Typing is likewise transport-owned now — TypingIndicating.startTyping at
// dispatch + clearTypingExternal at turn-end.)

/** Per-topic queue of ack handles awaiting the "read" flip. Drained on onFlush. */
const pendingReadAcks: Map<string, AckHandle[]> = new Map();

function trackPendingRead(threadIdStr: string, handle: AckHandle): void {
  let list = pendingReadAcks.get(threadIdStr);
  if (!list) { list = []; pendingReadAcks.set(threadIdStr, list); }
  list.push(handle);
}

/** Registry onFlush hook: the batch just got written to claude's stdin, so every
 *  queued message in this turn is now "read" by the LLM. One flush → many handles
 *  flipped to 👌 at once (N:1). */
function onDaemonFlush(threadIdStr: string, _combinedText: string): void {
  const list = pendingReadAcks.get(threadIdStr);
  if (!list || list.length === 0) return;
  pendingReadAcks.delete(threadIdStr);
  if (isReactable(transport)) void transport.setReadAcks(list);
}

// ─── topic name cache ────────────────────────────────────────────────────────
// Bot API has no getForumTopic / getForumTopicByID, so the only way to learn
// a forum topic's user-set name is to observe forum_topic_created or
// forum_topic_edited service messages as they fly past. We persist what we
// see to topics.json so the Pager UI can display "topic 42 (Plans)" instead
// of bare "topic 42".
//
// Limitation surfaced in Pager UI: topics created BEFORE the bot joined the
// group are invisible — until someone renames them (forum_topic_edited fires).

interface TopicsFile {
  version: 1;
  topics: Record<string, { name: string; captured_at: string }>;
}

function readTopics(): TopicsFile {
  try {
    const raw = readFileSync(TOPICS_JSON, "utf8");
    const parsed = JSON.parse(raw) as TopicsFile;
    if (parsed.version === 1 && typeof parsed.topics === "object") return parsed;
  } catch { /* missing or unparseable — start empty */ }
  return { version: 1, topics: {} };
}

function writeTopics(data: TopicsFile): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${TOPICS_JSON}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, TOPICS_JSON);
}

/** Record a topic name observed from a forum_topic_{created,edited} service
 * message. Keyed by `<chat_id>/<thread_id>` so the same numeric thread id in
 * different chats doesn't collide. No-ops if name is empty. */
function recordTopicName(chat_id: number, thread_id: number, name: string): void {
  const key = `${chat_id}/${thread_id}`;
  const trimmed = name.trim();
  if (!trimmed) return;
  const data = readTopics();
  const existing = data.topics[key];
  if (existing?.name === trimmed) return; // no change; skip the disk write
  data.topics[key] = { name: trimmed, captured_at: new Date().toISOString() };
  try {
    writeTopics(data);
    process.stdout.write(`[${new Date().toISOString()}] topic name captured: ${key} → ${trimmed}\n`);
  } catch (e) {
    process.stderr.write(`poller: topics.json write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// Typing indicator moved to the ChatTransport (TypingIndicating). The poller
// calls transport.startTyping at dispatch and transport.clearTypingExternal at
// turn-end; the keepalive loop + the on-disk marker (read by Pager's
// isGenerating) live in the transport now.

// Telegram-friendliness instructions appended via --append-system-prompt
// on every daemon spawn (Phase 4). No picker-avoidance section because
// `claude -p --input-format stream-json` has no interactive arrow-key
// pickers at all. Plain text replies come back via the stream-json `result`
// event. P4: claude has no chat tools (mcp-telegram retired); to offer tap
// choices it emits a `[[buttons]]` marker the poller parses (buttons-marker.ts)
// and routes to ChatTransport.sendButtons.
const DAEMON_APPEND_SYSTEM_PROMPT = `You are responding through a Telegram bot. The user is on Telegram; your terminal output is NOT visible to them.

Just write your reply as plain text — the bot reads your final text and posts it. You have no chat tools to call.

When you need the user to choose between a small fixed set of options (Yes/No, A/B/C, two paths forward), end your reply with a marker line in exactly this format: [[buttons]]["Option A","Option B"] — a JSON array of up to 8 short labels (each ≤50 chars). The bot renders them as tap buttons and the tapped label comes back as the user's next message. Put the question in normal text above the marker. Do NOT use AskUserQuestion — it opens a local modal that the user cannot see or answer.

Telegram renders replies as plain text, so do NOT use Markdown syntax (no **bold**, no headers, no - bullets, no backtick code fences) — those characters appear literally. Prefer 1-3 short paragraphs over walls of text. Write code or commands on plain lines without fences. Users are typically on phones; readability beats completeness. This brevity rule governs OUTPUT length ONLY — never the depth of your thinking.

Think deeply before you answer. Reason hard and thoroughly through the problem internally — chase the real cause, weigh the trade-offs, verify against the actual code or data rather than memory. Reason in English by default, even when the user writes in another language. Depth of reasoning is never what you cut; what you keep short is only the FINAL reply, distilled BLUF-first into 1-3 tight paragraphs in the user's language. Short answer, deep thought — never a shallow one.

You also have access to ~/.pager/shared-context.md — a cross-session memory file shared with every other Pager-bot claude session on this host. Read it when the user references prior context, or near the start of substantive conversations. Append durable notes there (user preferences, ongoing concerns, decisions, recurring patterns) so future sessions across other topics/projects benefit. Keep entries short and avoid duplication.

IMPORTANT — Telegram pairing / access is handled by claude-telegram-agent, NOT by the official @claude-plugins-official/telegram plugin. If the user asks about pairing, unpair, allowlist, or access changes, DO NOT invoke skills named \`telegram:access\`, \`telegram:configure\`, or anything from \`@claude-plugins-official/telegram\`. Instead:
  - To unpair the current chat: tell the user to send \`/unpair confirm\` in the Telegram chat, OR to run \`cta unpair\` in their terminal.
  - To re-pair to a different chat: unpair first, then either invite the bot to a new chat (auto-pair prompt fires) or send \`/pair <code>\` (code visible via \`cta pair-code\` on the host).
  - To mount a project to a topic: \`/mount <path>\` inside that topic.`;

// ─── daemon dispatch (Phase 4) ─────────────────────────────────────────────
// Per-topic long-lived claude subprocess. No more tmux interactive TUI on
// the bot's hot path. ClaudeDaemonRegistry owns the lifecycle (spawn,
// debounce, queue, crash respawn); poller wires only the chat side.

// P4: the per-topic --mcp-config (which wired the buttons-only mcp-telegram
// server) is gone. The daemon now spawns with NO poller-supplied --mcp-config,
// so claude inherits only the user's own ~/.claude.json MCP servers (Notion,
// browser, gmail, …) and has zero chat tools. Outbound text + buttons both
// flow back through the stream (buttons via the [[buttons]] marker → poller →
// ChatTransport.sendButtons). mcp-telegram is retired.

/**
 * Build the daemon options for a topic. Resolves project_path from the
 * mount cache, session UUID from $STATE_DIR/sessions/<thread_id>, and
 * MCP config path. Called by the registry on every spawn (including
 * crash respawns) so config stays in sync with mount changes.
 */
// ─── per-topic --effort level (single source of truth: EFFORT_SPECS) ─────────
// Every effort value the bot accepts is ONE ROW in EFFORT_SPECS below. The
// validator, the --effort arg mapping, the optional system-prompt directive, and
// the user-facing usage/help/menu strings all DERIVE from it — so adding a level
// (a real claude tier or a bot sentinel) is a one-line edit here, nothing else,
// and the help text can't drift out of sync.
//   arg=null    → sentinel: omit --effort entirely (claude uses its own
//                 settings.json default). "auto" is this.
//   arg=<tier>  → spawn `--effort <tier>`. A sentinel like "ultracode" maps to a
//                 real tier (xhigh) and carries its own directive.
//   directive   → appended to the daemon system prompt while this level is active.
//   blurb       → short "name = meaning" hint for /effort usage (sentinels only).

/** Appended to the daemon's system prompt for topics on /effort ultracode.
 *  Increases the DEPTH of the work, not the length of the Telegram reply (the
 *  base prompt's brevity rule still governs output). claude has no native
 *  ultracode in headless mode, so this is how the bot expresses it. */
const ULTRACODE_DIRECTIVE = [
  "Ultracode mode is ON for this topic. Optimize for the most exhaustive, correct answer — not the fastest or cheapest. Token cost is not a constraint on your reasoning.",
  "Verify against the actual code/data before answering rather than from memory; on substantive tasks decompose the problem and adversarially check your own work.",
  "If a Workflow / multi-agent orchestration tool is available to you, use it to fan out and verify on substantive tasks; otherwise do that depth of reasoning yourself. Stay solo for trivial or conversational turns.",
  "This raises the depth of your work, NOT the length of your message — keep the final Telegram reply as concise as always (short answer, deep thought).",
].join(" ");

interface EffortSpec {
  /** The `--effort` arg, or null to omit the flag (sentinel → claude's default). */
  readonly arg: string | null;
  /** Appended to the daemon system prompt while this level is active. */
  readonly directive?: string;
  /** Short "meaning" hint for /effort usage — only the non-obvious sentinels. */
  readonly blurb?: string;
}

/** THE source of truth for accepted effort levels. Add a row → fully supported. */
const EFFORT_SPECS: Record<string, EffortSpec> = {
  low:       { arg: "low" },
  medium:    { arg: "medium" },
  high:      { arg: "high" },
  xhigh:     { arg: "xhigh" },
  max:       { arg: "max" },
  auto:      { arg: null,    blurb: "let claude use its own default" },
  ultracode: { arg: "xhigh", directive: ULTRACODE_DIRECTIVE, blurb: "xhigh + go exhaustive" },
};

const isValidEffort = (e: string): boolean =>
  Object.prototype.hasOwnProperty.call(EFFORT_SPECS, e);
/** "low|medium|…|ultracode" — derived so usage/help/menu can't drift. */
const EFFORT_NAMES = Object.keys(EFFORT_SPECS).join("|");
/** "auto = …; ultracode = …" — sentinel blurbs, for /effort usage. */
const EFFORT_BLURBS = Object.entries(EFFORT_SPECS)
  .filter(([, s]) => s.blurb)
  .map(([n, s]) => `${n} = ${s.blurb}`)
  .join("; ");

// Bot-wide default. Overridable via PAGER_EFFORT in ~/.pager/.env. Deliberately
// independent of the user's GLOBAL settings.json effortLevel (which also drives
// their desktop claude) — the bot defaults to "high" for snappier phone replies.
const DEFAULT_EFFORT =
  process.env.PAGER_EFFORT && isValidEffort(process.env.PAGER_EFFORT)
    ? process.env.PAGER_EFFORT
    : "high";
function effortDir(): string { return join(STATE_DIR, "effort"); }
/** Per-topic effort override (set via /effort), else the bot default. Returns
 *  the RAW stored value (incl. sentinels) for display; daemon argv goes through
 *  effortArg(). */
function resolveEffort(key: number | "dm"): string {
  try {
    const v = readFileSync(join(effortDir(), String(key)), "utf8").trim();
    if (isValidEffort(v)) return v;
  } catch { /* no override → default */ }
  return DEFAULT_EFFORT;
}
/** The actual --effort arg for a resolved level (null sentinel / unknown →
 *  undefined so buildArgv omits the flag). */
function effortArg(eff: string): string | undefined {
  return EFFORT_SPECS[eff]?.arg ?? undefined;
}
/** The system-prompt directive for a resolved level, if any (e.g. ultracode). */
function effortDirective(eff: string): string | undefined {
  return EFFORT_SPECS[eff]?.directive;
}

// ─── per-topic --model ───────────────────────────────────────────────────────
// Accept aliases (opus/sonnet/haiku/…) or a full claude-* id. Loose validation
// (claude itself rejects truly bogus names at spawn); we just block shell-junk.
const MODEL_RE = /^[A-Za-z0-9._:-]{2,64}$/;
function modelDir(): string { return join(STATE_DIR, "model"); }
/** Per-topic model override (set via /model), else CLAUDE_MODEL env, else
 *  undefined → claude's own default. */
function resolveModel(key: number | "dm"): string | undefined {
  try {
    const v = readFileSync(join(modelDir(), String(key)), "utf8").trim();
    if (MODEL_RE.test(v)) return v;
  } catch { /* no override */ }
  return process.env.CLAUDE_MODEL || undefined;
}

function buildDaemonOpts(threadIdStr: string): Omit<ClaudeDaemonOptions, "claudeBin"> {
  const key: number | "dm" = threadIdStr === "dm" ? "dm" : Number(threadIdStr);
  const mount = mountsCache.get(tgKey(key));
  if (!mount) throw new Error(`buildDaemonOpts: no mount for ${threadIdStr}`);

  // Per-topic session UUID. Generate on first launch; re-use on subsequent.
  const sessFile = join(sessionsDir(), String(key));
  let uuid: string;
  if (existsSync(sessFile)) {
    uuid = readFileSync(sessFile, "utf8").trim();
    if (!uuid) uuid = randomUUID();
  } else {
    uuid = randomUUID();
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(sessFile, uuid + "\n", { mode: 0o600 });
  }
  // --resume needs JSONL to exist; otherwise --session-id starts fresh.
  const jsonlExists = existsSync(jsonlPathForSession(mount.path, uuid));

  const hooksPath = process.env.TOPIC_WRAPPER_HOOKS_PATH
    ?? join(process.env.CTA_INSTALL_DIR ?? join(homedir(), ".local/share/pager"), "bot-hooks.json");

  return {
    cwd: mount.path,
    sessionUuid: uuid,
    resumeExisting: jsonlExists,
    // P4: no poller --mcp-config; claude inherits the user's own MCPs only.
    settingsPath: existsSync(hooksPath) ? hooksPath : undefined,
    appendSystemPrompt: (() => {
      const base = process.env.BOT_APPEND_SYSTEM_PROMPT ?? DAEMON_APPEND_SYSTEM_PROMPT;
      const dir = effortDirective(resolveEffort(key));
      return dir ? `${base}\n\n${dir}` : base;
    })(),
    effort: effortArg(resolveEffort(key)),
    model: resolveModel(key),
  };
}

// /effort <level> over Telegram: set the per-topic --effort level and respawn
// the topic's daemon so it takes effect immediately. No arg → show current +
// valid levels.
async function handleEffort(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  const key = threadIdOf(ev);
  const level = args.trim().toLowerCase().split(/\s+/)[0];

  if (!level) {
    await reply(dest, `effort for this topic: ${resolveEffort(key)} (default ${DEFAULT_EFFORT})\nUsage: /effort <${EFFORT_NAMES}>  (${EFFORT_BLURBS})`);
    return;
  }
  if (!isValidEffort(level)) {
    await reply(dest, `"${level}" is not valid. Choose: ${EFFORT_NAMES.replace(/\|/g, ", ")}.`);
    return;
  }
  try {
    mkdirSync(effortDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(effortDir(), String(key)), level + "\n", { mode: 0o600 });
  } catch (e) {
    await reply(dest, `Couldn't save effort: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Respawn the daemon so the new --effort applies on the next turn.
  try {
    if (daemonRegistry) await daemonRegistry.resetTopic(String(key));
  } catch (e) {
    process.stderr.write(`poller: handleEffort resetTopic failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  await reply(dest, `effort set to ${level} for this topic (applies on your next message).`);
}

// /model <alias|id> over Telegram: set the per-topic model and respawn the
// topic's daemon. No arg → show current.
async function handleModel(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  const key = threadIdOf(ev);
  const name = args.trim().split(/\s+/)[0];

  if (!name) {
    await reply(dest, `model for this topic: ${resolveModel(key) ?? "(claude default)"}\nUsage: /model <opus|sonnet|haiku|full-id>`);
    return;
  }
  if (!MODEL_RE.test(name)) {
    await reply(dest, `"${name}" doesn't look like a model name. Use an alias (opus/sonnet/haiku) or a full id (claude-…).`);
    return;
  }
  try {
    mkdirSync(modelDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(modelDir(), String(key)), name + "\n", { mode: 0o600 });
  } catch (e) {
    await reply(dest, `Couldn't save model: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  try {
    if (daemonRegistry) await daemonRegistry.resetTopic(String(key));
  } catch (e) {
    process.stderr.write(`poller: handleModel resetTopic failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  await reply(dest, `model set to ${name} for this topic (applies on your next message). If it's an invalid name, claude will fail to start — send /model with a valid one.`);
}

// /context over Telegram: approximate current context-window usage from the
// transcript's last turn.
async function handleContext(ev: InboundMessageEvent): Promise<void> {
  const key = threadIdOf(ev);
  const dest = ev.address;
  const mount = mountsCache.get(tgKey(key));
  if (!mount) { await reply(dest, "No mount in this topic — `/mount <path>` first."); return; }
  const jsonl = jsonlPathForMount(mount);
  const ctx = jsonl ? lastContextFromJsonl(jsonl) : null;
  if (!ctx) { await reply(dest, "No turns recorded yet — send a message in this topic first."); return; }
  const win = contextWindowFor(ctx.model);
  const pct = Math.round((ctx.tokens / win) * 100);
  await reply(dest, `context: ~${ctx.tokens.toLocaleString()} / ${win.toLocaleString()} tokens (${pct}%) · ${ctx.model}\n(approx — last turn's prompt size)`);
}

/** Parse a registry threadId (string) back into the TG numeric form. */
function parseRegistryThreadId(threadIdStr: string): number | undefined {
  return threadIdStr === "dm" ? undefined : Number(threadIdStr);
}

/**
 * Singleton ClaudeDaemonRegistry. Initialized in main() after env setup so
 * the daemon-opts factory has access to the live MAIN_CHAT_ID / paired
 * state. Module-level let so daemonDispatch can reference it without
 * passing it through dispatchUpdate's stack.
 */
let daemonRegistry: ClaudeDaemonRegistry | null = null;

/**
 * Wiring: pump each assistant text block out to Telegram. multi-message
 * UX is automatic because claude code emits one assistant event per
 * text/tool_use block during a turn.
 */
function postTelegramTextFromDaemon(threadIdStr: string, text: string): void {
  const chatIdStr = effectiveChatId();
  if (!chatIdStr) return;
  const chat_id = Number(chatIdStr);
  if (!Number.isFinite(chat_id)) return;
  const threadId = parseRegistryThreadId(threadIdStr);
  // P4: claude has no send_telegram tool. To offer tap choices it emits a
  // [[buttons]] marker in its reply text; parse it out and route to the
  // transport's ButtonCapable path. No marker → plain text as before.
  const { body, buttons } = parseButtonsMarker(text);
  if (buttons && buttons.length > 0 && isButtonCapable(transport)) {
    void transport.sendButtons({
      to: { channel: "telegram", chatId: chat_id, threadId },
      text: body || "Choose:",
      buttons,
    });
    return;
  }
  // No buttons, or the platform can't render them → plain text (graceful degrade).
  void reply(tgAddr(chat_id, threadId), body);
}

/** Send a plain operational notice into a topic (spawn-fail / crash-loop). Same
 *  chat/thread resolution as postTelegramTextFromDaemon, minus button parsing. */
function notifyTopic(threadIdStr: string, text: string): void {
  const chatIdStr = effectiveChatId();
  if (!chatIdStr) return;
  const chat_id = Number(chatIdStr);
  if (!Number.isFinite(chat_id)) return;
  void reply(tgAddr(chat_id, parseRegistryThreadId(threadIdStr)), text);
}

/** The daemon couldn't be spawned at all — surface it instead of going silent. */
function onDaemonSpawnFail(threadIdStr: string): void {
  process.stderr.write(`[${new Date().toISOString()}] daemon spawn failed for thread ${threadIdStr}\n`);
  notifyTopic(
    threadIdStr,
    "⚠️ Couldn't start a Claude session in this topic. Check that claude is on the agent's PATH (run cta status), the model, and the mounted directory. Logs: ~/.pager/agent.log",
  );
}

/** claude spawns but dies every turn (bad /model, corrupt session, auth) — tell
 *  the user once at the threshold rather than leaving them in silence. */
function onDaemonCrashLoop(threadIdStr: string, crashCount: number): void {
  process.stderr.write(`[${new Date().toISOString()}] daemon crash-loop for thread ${threadIdStr} (${crashCount}x)\n`);
  notifyTopic(
    threadIdStr,
    `⚠️ Claude keeps crashing in this topic (${crashCount}x in a row) — likely a bad /model, an unreadable session, or an auth error. Check ~/.pager/agent.log; /clear may help.`,
  );
}

/** Turn-start hook: (re-)assert the typing indicator for this topic. Fires on
 *  every turn the registry starts — including a steered continuation after a
 *  mid-turn interrupt, whose interrupted turn-end already cleared typing.
 *  Without this, the bot keeps working with no "typing…" bubble (looks dead). */
function onDaemonTurnStart(threadIdStr: string): void {
  const chatIdStr = effectiveChatId();
  if (!chatIdStr) return;
  const chat_id = Number(chatIdStr);
  if (!Number.isFinite(chat_id)) return;
  if (isTyping(transport)) {
    void transport.startTyping({ channel: "telegram", chatId: chat_id, threadId: parseRegistryThreadId(threadIdStr) });
  }
}

/** Turn-end hook: clear typing keepalive (mcp-telegram normally does this
 *  on send_telegram; in daemon mode plain-text replies bypass MCP so we
 *  must clear ourselves), log cost. */
function onDaemonTurnEnd(threadIdStr: string, info: { costUsd: number | null; sessionId: string | null }): void {
  const chatIdStr = effectiveChatId();
  if (chatIdStr) {
    const chat_id = Number(chatIdStr);
    if (Number.isFinite(chat_id)) {
      if (isTyping(transport)) void transport.clearTypingExternal({ channel: "telegram", chatId: chat_id, threadId: parseRegistryThreadId(threadIdStr) });
    }
  }
  if (typeof info.costUsd === "number") {
    process.stdout.write(`[${new Date().toISOString()}] daemon turn-end cost: $${info.costUsd.toFixed(4)} (session=${info.sessionId}, thread=${threadIdStr})\n`);
  }
}

/** Initialize the daemon registry. Called once in main(). */
function initDaemonRegistry(): void {
  if (daemonRegistry) return;
  daemonRegistry = new ClaudeDaemonRegistry({
    debounceMs: Number(process.env.PAGER_DAEMON_DEBOUNCE_MS ?? "2000"),
    // Self-heal guards (incident 2026-05-21). Defaults are conservative;
    // overridable for tuning + fast live verification.
    //   RELEASE_MAX_MS      — orphaned β-handoff TTL (released topic abandoned
    //                          by a dead terminal → next message reacquires)
    //   INFLIGHT_TIMEOUT_MS — inactivity watchdog for a wedged turn
    releaseMaxMs: Number(process.env.RELEASE_MAX_MS ?? `${10 * 60_000}`),
    inFlightTimeoutMs: Number(process.env.INFLIGHT_TIMEOUT_MS ?? `${5 * 60_000}`),
    // Test seam: e2e scenarios point this at fixtures/fake-claude-daemon.sh so
    // a turn can run without spawning real `claude`. Unset in production →
    // registry defaults to "claude".
    claudeBin: process.env.PAGER_CLAUDE_BIN || undefined,
    daemonOptsFor: buildDaemonOpts,
    // Mid-turn auto-steer: read interruptOnMessage live so the settings reload
    // takes effect without reconstructing the registry. Default debounce 1500ms;
    // overridable via PAGER_INTERRUPT_DEBOUNCE_MS for e2e tests (fast scenarios).
    autoSteerEnabled: () => interruptOnMessage,
    interruptDebounceMs: Number(process.env.PAGER_INTERRUPT_DEBOUNCE_MS ?? "1500"),
    // Post-interrupt escalation: claude v2.1.150 frequently ACKs an interrupt
    // but never emits a result (the 2026-05-25 "General stopped responding"
    // wedge). Without this, the only recovery was the 5-min inFlight watchdog →
    // 5 min of silence. 12s SIGKILLs + respawns + flushes the steer instead.
    interruptEscalateMs: Number(process.env.PAGER_INTERRUPT_ESCALATE_MS ?? "12000"),
    onText: postTelegramTextFromDaemon,
    onFlush: onDaemonFlush,
    onTurnStart: onDaemonTurnStart,
    onTurnEnd: onDaemonTurnEnd,
    onSpawnFail: onDaemonSpawnFail,
    onCrashLoop: onDaemonCrashLoop,
  });
}

/**
 * Phase 4 dispatch: hand the message to the registry. Registry handles
 * spawn-if-needed, debounce, per-topic queue, turn streaming, and crash
 * recovery. Fire-and-forget — replies flow back via the onText callback,
 * not via this function's return value.
 */
async function daemonDispatch(threadIdStr: string, ev: InboundMessageEvent): Promise<void> {
  const text = ev.text;
  if (!text) return;
  if (!daemonRegistry) {
    process.stderr.write("poller: daemonDispatch called before initDaemonRegistry — initializing on demand\n");
    initDaemonRegistry();
  }
  // Typing keepalive (via the transport) — fast platform call + disk marker,
  // cleared at turn-end via clearTypingExternal. Fire-and-forget.
  if (isTyping(transport)) void transport.startTyping(ev.address);
  // Delivered ack (👀): the transport reads the operator glyph (access.json) and
  // returns a handle to flip to 👌 on flush — or null if the operator disabled it
  // (skip the ack pipeline). Await so the handle is queued BEFORE enqueue; the
  // flush fires ≥ debounce later, so it always finds it (no race).
  const ack = isReactable(transport)
    ? await transport.setDeliveredAck(ev.messageRef)
    : null;
  if (ack) trackPendingRead(threadIdStr, ack);

  daemonRegistry!.enqueue(threadIdStr, text);
}

/** Public API for cta / Pager IPC — kill the daemon for a topic so the
 *  user can attach a TUI via `claude --resume <uuid>`. Awaited by callers. */
export async function releaseDaemonForTerminal(threadId: number | "dm"): Promise<void> {
  if (!daemonRegistry) return;
  await daemonRegistry.releaseForTerminal(String(threadId));
}

/** Public API: re-acquire daemon after user closes their TUI. */
export async function reacquireDaemonFromTerminal(threadId: number | "dm"): Promise<void> {
  if (!daemonRegistry) return;
  await daemonRegistry.reacquireFromTerminal(String(threadId));
}

/** Public API: full reset for /clear — stop the running daemon and drop
 *  the topic's registry entry so the next enqueue lazy-spawns fresh
 *  (picking up the rotated session UUID written by handleClear). */
export async function resetDaemonTopic(threadId: number | "dm"): Promise<void> {
  if (!daemonRegistry) return;
  await daemonRegistry.resetTopic(String(threadId));
}

// ─── β handoff (Open in Terminal) IPC ────────────────────────────────────────
// Pager / `cta release-daemon` write flag files into $STATE_DIR/release-flags/
// to request that a topic's daemon yield its claude session lock so the user
// can attach via `claude --resume <uuid>`. We poll the dir every loop tick
// (cheap — usually empty). Protocol:
//   <thread_id>            written by caller → release the daemon, then
//                          rename to <thread_id>.ack so the caller's polling
//                          loop knows the kill completed.
//   <thread_id>.ack        the release ack — its presence means "released".
//                          The caller deletes this to signal reacquire.
//
// On poller restart, any stale .ack files left behind by a prior run get
// cleaned up so the new poller doesn't think topics are stuck released.

const RELEASE_FLAG_DIR = join(STATE_DIR, "release-flags");

function ensureReleaseFlagDir(): void {
  try { mkdirSync(RELEASE_FLAG_DIR, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
}

/** Snapshot every entry in release-flags/ once per tick. Cheap when empty;
 *  in steady state nobody's clicking "Open in Terminal" so this is a single
 *  readdir on a directory with zero entries.
 *
 *  Behavior:
 *  - bare `<thread_id>` file (no .ack sibling) → release daemon, rename to .ack
 *  - missing `<thread_id>` AND missing `.ack` → if registry says "released",
 *    reacquire (the caller deleted both files).
 *  - .ack alone → status quo, do nothing. */
async function processReleaseFlags(): Promise<void> {
  if (!daemonRegistry) return;
  let names: string[];
  try {
    names = require("node:fs").readdirSync(RELEASE_FLAG_DIR) as string[];
  } catch {
    return; // dir doesn't exist yet; ensure on startup
  }
  // Build per-thread state: did we see the request file, the ack file, both,
  // or neither?
  const states = new Map<string, { request: boolean; ack: boolean }>();
  for (const name of names) {
    const isAck = name.endsWith(".ack");
    const thread = isAck ? name.slice(0, -4) : name;
    const cur = states.get(thread) ?? { request: false, ack: false };
    if (isAck) cur.ack = true;
    else cur.request = true;
    states.set(thread, cur);
  }
  const justReleased = new Set<string>();
  for (const [thread, { request, ack }] of states) {
    if (request && !ack) {
      try {
        await daemonRegistry.releaseForTerminal(thread);
        renameSync(join(RELEASE_FLAG_DIR, thread), join(RELEASE_FLAG_DIR, `${thread}.ack`));
        justReleased.add(thread);
        process.stdout.write(`[${new Date().toISOString()}] β: released daemon for thread ${thread}\n`);
      } catch (e) {
        process.stderr.write(`poller: release-flag processing failed for ${thread}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  }
  // Detect reacquire: registry has a topic in "released" state but no .ack
  // file present. Caller deleted the ack to signal "TUI is closed, bring
  // the daemon back". Skip topics we JUST released this tick — their .ack
  // exists on disk but our local `states` map is stale (built before the
  // rename), so we'd incorrectly think the caller deleted the ack.
  for (const [thread] of daemonRegistry.snapshotQueues()) {
    if (justReleased.has(thread)) continue;
    if (daemonRegistry.getStatus(thread) !== "released") continue;
    // Re-stat instead of trusting the stale states map.
    const ackPath = join(RELEASE_FLAG_DIR, `${thread}.ack`);
    if (existsSync(ackPath)) continue;
    try {
      await daemonRegistry.reacquireFromTerminal(thread);
      process.stdout.write(`[${new Date().toISOString()}] β: reacquired daemon for thread ${thread}\n`);
    } catch (e) {
      process.stderr.write(`poller: reacquire failed for ${thread}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

/** Clean stale .ack files on startup so a poller restart while flags are
 *  set doesn't leave topics stuck released. */
function cleanupStaleReleaseFlags(): void {
  try {
    const names = require("node:fs").readdirSync(RELEASE_FLAG_DIR) as string[];
    for (const name of names) {
      try { unlinkSync(join(RELEASE_FLAG_DIR, name)); } catch { /* best effort */ }
    }
  } catch { /* dir missing, nothing to clean */ }
}

// ─── Watch-live input IPC (Phase 4 daemon mode) ──────────────────────────────
// Pager's "Watch live" input field and `cta send` deliver text into a topic by
// dropping a file into $STATE_DIR/inject/. In Phase 4 the daemon's stdin is
// owned by this poller (there's no per-topic tmux session to paste into
// anymore — the old `cta send` tmux path is dead), so an external caller can't
// reach the daemon directly; it hands off through this drop-dir instead.
//
// Filename: `<thread_id>__<nonce>.txt` (thread_id is "dm" or numeric — never
// contains "__"). cta writes atomically (`.tmp` then rename) so we never read a
// partial file. We delete each file BEFORE enqueueing so a crash drops rather
// than re-injects (same durability stance as the getUpdates offset).
//
// Latency: an fs.watch fires processing instantly even while the getUpdates
// long-poll is blocked; the per-tick poll in the main loop is the fallback in
// case a watch event is missed.
const INJECT_DIR = join(STATE_DIR, "inject");

function ensureInjectDir(): void {
  try { mkdirSync(INJECT_DIR, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
}

let injectProcessing = false;
async function processInjectFlags(): Promise<void> {
  if (!daemonRegistry) return;
  if (injectProcessing) return; // re-entrancy guard (watch + loop can overlap)
  injectProcessing = true;
  try {
    const fs = require("node:fs");
    let names: string[];
    try {
      names = (fs.readdirSync(INJECT_DIR) as string[])
        .filter((n) => n.endsWith(".txt"))
        .sort(); // ts-prefixed nonce → rough FIFO ordering
    } catch {
      return; // dir missing; ensured on startup
    }
    for (const name of names) {
      const full = join(INJECT_DIR, name);
      const sep = name.indexOf("__");
      if (sep <= 0) { try { fs.unlinkSync(full); } catch { /* */ } continue; }
      const threadId = name.slice(0, sep);
      let text: string;
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      try { fs.unlinkSync(full); } catch { /* */ } // delete before enqueue
      const trimmed = text.replace(/\s+$/, "");
      if (!trimmed) continue;
      daemonRegistry.enqueue(threadId, trimmed);
      process.stdout.write(`[${new Date().toISOString()}] inject: thread ${threadId} (${trimmed.length} chars)\n`);
    }
  } finally {
    injectProcessing = false;
  }
}

let injectWatcher: { close(): void } | null = null;
function startInjectWatcher(): void {
  if (injectWatcher) return;
  try {
    injectWatcher = require("node:fs").watch(INJECT_DIR, () => { void processInjectFlags(); });
  } catch (e) {
    // fs.watch unsupported on this filesystem — the per-tick loop poll still
    // drains the dir, just at long-poll cadence instead of instantly.
    process.stderr.write(`poller: inject fs.watch unavailable (${e instanceof Error ? e.message : String(e)}); using loop-poll fallback\n`);
  }
}

// ─── auto-pair via bot invite (Phase 5) ──────────────────────────────────────
// Replaces "user must type /pair <code>" with "bot detects when it's added
// to a chat, sends an inline-keyboard prompt asking the inviter to confirm".
// The user never copies a code — Telegram already tells us who invited the
// bot, we just ask them to tap a button.

let botUserId: number | null = null; // captured from preflight (getMe)
let pendingPair: { chat_id: number; inviter_user_id: number; expires_at: number } | null = null;
const PENDING_PAIR_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Telegram fires this when the bot's status in a chat changes. We care about
 * the case where the bot was just added (old status ∈ {left,kicked} →
 * new status ∈ {member,administrator}) AND we don't have a paired chat yet.
 */
export async function handleMyChatMember(mcm: TgChatMemberUpdated): Promise<void> {
  // Backfill botUserId if the boot-time preflight getMe failed (Wi-Fi not up at
  // launchd start, captive portal, transient DNS). Without this it stays null
  // for the whole process lifetime and the auto-pair-on-invite flow below never
  // fires (the comment at preflight said "will retry in main loop" but nothing
  // did). my_chat_member is rare, so a getMe here is cheap and self-limiting.
  if (botUserId == null) {
    try {
      const me = await getMe();
      if (me.ok && me.result?.id != null) {
        botUserId = me.result.id;
        process.stdout.write(`[${new Date().toISOString()}] backfilled bot id=${botUserId} (boot preflight had failed)\n`);
      }
    } catch { /* still offline — bail; the next my_chat_member retries */ }
  }
  if (mcm.new_chat_member.user.id !== botUserId) return; // not us
  const oldS = mcm.old_chat_member.status;
  const newS = mcm.new_chat_member.status;
  const justAdded = (oldS === "left" || oldS === "kicked") &&
                    (newS === "member" || newS === "administrator");
  if (!justAdded) {
    // Other transitions: log if interesting (kicked from paired chat etc).
    if ((newS === "kicked" || newS === "banned") && pairedCache?.chat_id === mcm.chat.id) {
      process.stderr.write(`poller: WARNING bot was ${newS} from paired chat ${mcm.chat.id}. Operator should investigate.\n`);
    }
    return;
  }
  if (pairedCache) {
    await reply(
      tgAddr(mcm.chat.id),
      [
        "I'm already paired with another chat — I can't claim two at once.",
        "",
        "To re-pair with this chat instead:",
        "  • In the existing paired chat, send `/unpair confirm`, OR",
        "  • Run `cta unpair` on the host.",
        "Then kick + re-add me here and send `/pair <CODE>` (get it via `cta pair-code` on the host).",
      ].join("\n"),
    );
    return;
  }
  // Deterministic pairing flow: ask the user to send `/pair <code>` rather
  // than the inline-keyboard callback_query dance. The callback flow depended
  // on bot membership state being settled (callback_query delivery requires
  // the bot to see the user's tap), which created a chicken-and-egg with
  // privacy/admin caches in forum groups — failing pairs left the bot
  // unpairable without a kick+re-add cycle. /pair <code> is a `/command`,
  // which Telegram delivers even to non-admin privacy-enabled bots.
  // Group-vs-DM: in groups, Telegram caches the bot's "privacy mode" at
  // invite time. If privacy was on when the bot was added, only `/commands`
  // come through — plain text gets dropped server-side. Admin status
  // overrides this cache. So for groups, tell the user explicitly.
  const isGroup = mcm.chat.id < 0; // negative chat_id = group / supergroup / channel
  const introLines = [
    "👋 Hi! To finish setup:",
    "",
    "1. On your Mac, run: `cta pair-code`",
    "2. Send the code back here as: `/pair YOUR-CODE`",
  ];
  if (isGroup) {
    introLines.push(
      "",
      "⚠ For me to see plain text in this group, please promote me to admin (any minimal permission works). Without admin, I only see /commands.",
    );
  }
  introLines.push(
    "",
    "Already paired with another chat? Just send `/pair` here (no code needed) and I'll switch.",
  );
  await reply(tgAddr(mcm.chat.id), introLines.join("\n"));
  process.stdout.write(`[${new Date().toISOString()}] pair intro sent: chat=${mcm.chat.id} inviter=${mcm.from.id}${isGroup ? " (group)" : ""}\n`);
}

export async function onButtonPress(ev: ButtonPressEvent): Promise<void> {
  // answerCallback (dismiss the tap's spinner) is genuinely Telegram-only — the
  // normalized event doesn't model it, so reach the query id via raw. cb.message
  // (the prompt) likewise survives only on raw: we echo its text + drop its
  // keyboard via editMessageText.
  const cb = (ev.raw as TgUpdate).callback_query;
  if (!cb) return; // a button-press event always wraps a Telegram callback_query
  const data = ev.label;
  const dest = ev.address;
  if (!data) { await answerCallback(cb.id); return; }
  const isPairedUser = !!pairedCache && ev.from.id === String(pairedCache.user_id);

  // Inline-keyboard answer to a buttons-marker prompt. callback_data shape:
  // `ans:<thread_id>:<label>`. We synthesize a normalized message event carrying
  // the label as text and route it through the SAME onInboundMessage path —
  // claude sees it exactly as if the user had typed the option. The paired-user
  // check mirrors routeMessage's enforcement for typed messages.
  if (data.startsWith("ans:")) {
    if (!isPairedUser) {
      await answerCallback(cb.id, "Only the paired user can answer.", true);
      return;
    }
    if (!cb.message) { await answerCallback(cb.id); return; }
    const rest = data.slice(4);
    const colonIdx = rest.indexOf(":");
    if (colonIdx < 0) { await answerCallback(cb.id); return; }
    const label = rest.slice(colonIdx + 1);
    await answerCallback(cb.id);
    // Immediate visual ack: append the chosen label to the original prompt and
    // drop the inline keyboard (one editMessageText does both per Bot API
    // semantics). User sees "↳ <choice>" the instant they tap.
    const originalText = cb.message.text ?? "";
    void editMessageText(cb.message.chat.id, cb.message.message_id, `${originalText}\n\n↳ ${label}`);
    // Re-inject the chosen label as the user's next message through the shared
    // normalized pipeline (replaces the old synthetic-TgUpdate → dispatchUpdate).
    await onInboundMessage({
      kind: "message",
      routingKey: ev.routingKey,
      address: ev.address,
      from: ev.from,
      text: label,
      messageRef: ev.messageRef,
      raw: ev.raw,
    });
    return;
  }

  // P6a: mount-choice button (`mnt:<thread>:<idx>`) — link the topic to the
  // chosen project dir, then prompt the user to resend. Index references the
  // deterministic mountCandidates() list (re-derived identically here).
  if (data.startsWith("mnt:")) {
    if (!isPairedUser) {
      await answerCallback(cb.id, "Only the paired user can answer.", true);
      return;
    }
    if (!cb.message) { await answerCallback(cb.id); return; }
    const rest = data.slice(4);
    const ci = rest.indexOf(":");
    if (ci < 0) { await answerCallback(cb.id); return; }
    const tidStr = rest.slice(0, ci);
    const idx = Number(rest.slice(ci + 1));
    const dir = mountCandidates()[idx];
    if (!dir) {
      await answerCallback(cb.id, "That option expired — send /mount <path>.", true);
      return;
    }
    await answerCallback(cb.id);
    try {
      await addMount({ thread_id: tidStr === "dm" ? "dm" : Number(tidStr), path: dir, label: mountBasename(dir) });
      refreshMountsIfChanged();
    } catch (e) {
      await reply(dest, `Couldn't link: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const original = cb.message.text ?? "";
    void editMessageText(cb.message.chat.id, cb.message.message_id, `${original}\n\n↳ linked to ${dir}`);
    await reply(dest, `Linked this topic to ${dir}. Send your message again and I'll start the session.`);
    return;
  }

  // Agentic approval tap: `apv:<id>:allow|deny|edit`. Writes the decision file the
  // gate hook is blocking on; Edit captures the next message as corrected params.
  if (data.startsWith("apv:")) {
    if (!isPairedUser) { await answerCallback(cb.id, "Only the paired user can approve.", true); return; }
    const parsed = parseApprovalCallback(data);
    if (!parsed) { await answerCallback(cb.id); return; }
    const { id, verb } = parsed;
    const req = readRequest(APPROVALS_DIR, id);
    const stamp = (suffix: string) => {
      if (cb.message) void editMessageText(cb.message.chat.id, cb.message.message_id, `${cb.message.text ?? ""}\n\n${suffix}`);
    };
    if (!req || Date.now() > req.expiresAt) {
      await answerCallback(cb.id, "That request expired.", true);
      stamp("⌛ Expired");
      return;
    }
    if (verb === "allow") {
      writeDecision(APPROVALS_DIR, id, { decision: "allow", at: new Date().toISOString() });
      await answerCallback(cb.id, "Approved");
      stamp("✅ Approved");
      return;
    }
    if (verb === "deny") {
      writeDecision(APPROVALS_DIR, id, { decision: "deny", at: new Date().toISOString(), reason: "rejected by user" });
      await answerCallback(cb.id, "Rejected");
      stamp("🚫 Rejected");
      return;
    }
    // verb === "edit": stash the pending edit; the next plain message supplies params.
    pendingAgenticEdit = { id, threadId: req.threadId, tool: req.tool, args: req.args as Record<string, unknown>, expiresAt: req.expiresAt };
    await answerCallback(cb.id, "Send the corrected command/params as your next message.");
    stamp("✏️ Editing — reply with the corrected version.");
    return;
  }

  // Pending pair expired or never set → tell the user and ack the callback.
  if (!pendingPair || pendingPair.expires_at < Date.now()) {
    pendingPair = null;
    await answerCallback(cb.id, "That prompt has expired. Remove and re-add me to try again.", true);
    return;
  }
  // Only the original inviter can answer.
  if (ev.from.id !== String(pendingPair.inviter_user_id)) {
    await answerCallback(cb.id, "Only the user who invited me can confirm.", true);
    return;
  }

  if (data === "pair-confirm") {
    const state: PairedState = {
      version: 1,
      chat_id: pendingPair.chat_id,
      user_id: pendingPair.inviter_user_id,
      paired_at: new Date().toISOString(),
    };
    writePairedAtomic(state);
    pairedCache = state;
    try { pairedMtimeMs = statSync(PAIRED_STATE_FILE).mtimeMs; } catch { /* ignore */ }
    pendingPair = null;
    await ensureWildcardMount();
    await answerCallback(cb.id, "Paired!");
    if (cb.message) {
      await reply(
        dest,
        [
          "✓ Paired with this chat. Only you can issue commands from now on.",
          "",
          "Any message you send in a topic auto-routes to claude. To bind a topic to a specific Mac directory, send `/mount ~/path` in that topic.",
        ].join("\n"),
      );
    }
    process.stdout.write(`[${new Date().toISOString()}] auto-pair confirmed: chat=${state.chat_id} user=${state.user_id}\n`);
  } else if (data === "pair-cancel") {
    pendingPair = null;
    await answerCallback(cb.id, "Pairing cancelled.");
    if (cb.message) {
      await reply(
        dest,
        "Pairing cancelled. Remove me and re-add when you're ready, or use `/pair <code>` (run `cta pair-code` on the host to see it).",
      );
    }
  }
}

/** Test hook so unit tests can stage the bot's user id without preflight. */
export function _setBotUserIdForTest(id: number | null): void { botUserId = id; }

/**
 * Ensure a wildcard mount (`thread_id = "*"`) exists pointing at CLAUDE_CWD.
 * Called after auto-pair confirm and /pair success — without this, a
 * fresh-paired chat has no mounts.json entry, so the very first message
 * arrives, finds nothing in routeMessage, and silently drops. install.sh
 * creates the wildcard on first install but `cta unpair` clears mounts.json
 * (without --keep-mounts), so the next re-pair would start empty.
 */
async function ensureWildcardMount(): Promise<void> {
  const cwd = process.env.CLAUDE_CWD;
  if (!cwd) return; // nothing to default to; user must `cta mount` manually
  const current = readMounts();
  if (current.mounts.some((m) => m.thread_id === "*")) return;
  try {
    await addMount({ thread_id: "*", path: cwd, label: "default" });
    process.stdout.write(`[${new Date().toISOString()}] wildcard mount auto-created: * → ${cwd}\n`);
  } catch (e) {
    process.stderr.write(`poller: wildcard mount auto-create failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}


/** Rotate a topic's per-topic session UUID — the `/clear` lever. The next
 *  daemon spawn reads this file and uses --session-id with the fresh UUID (no
 *  --resume) → a cold, empty conversation. Shared by /clear and idle-clear.
 *  Returns false on write failure (caller decides how to surface it). */
function rotateSessionUuid(key: number | "dm"): boolean {
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), String(key)), randomUUID() + "\n");
    return true;
  } catch (e) {
    process.stderr.write(`poller: rotateSessionUuid failed for ${key}: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

// Prompt for the idle memory-flush turn. Tells claude to persist durable
// context to ~/.pager/shared-context.md (which every fresh daemon reads via
// its --append-system-prompt) BEFORE we rotate the session, then post a short
// user-facing notice. No user is waiting, so latency doesn't matter.
const IDLE_FLUSH_PROMPT = [
  "[automated housekeeping — no user is waiting on this]",
  "This conversation has grown large and is about to be reset to a fresh session so future replies stay fast and cheap.",
  "First: append anything durable worth keeping to ~/.pager/shared-context.md — the user's preferences, ongoing tasks, open decisions, and key facts from THIS conversation — concisely, and avoid duplicating what's already in the file.",
  "Then: reply with ONE short, friendly line telling the user you've saved the important context and started a fresh session to keep things fast.",
].join("\n");

/** Idle memory-flush + clear for one bloated topic. Runs DETACHED (never
 *  awaited inside the poll tick) so a multi-minute flush turn can't stall
 *  getUpdates. Flushes durable memory, then — only if the topic is still idle
 *  (a message arriving mid-flush means the user is back → keep the convo) —
 *  rotates the session UUID + resets the daemon so the next message is fresh
 *  and cheap. Guarded against overlapping flushes via idleFlushing. */
async function idleFlushAndClear(threadIdStr: string): Promise<void> {
  if (!daemonRegistry || idleFlushing.has(threadIdStr)) return;
  idleFlushing.add(threadIdStr);
  try {
    const key: number | "dm" = threadIdStr === "dm" ? "dm" : Number(threadIdStr);
    const result = await daemonRegistry.runTurnAndWait(threadIdStr, IDLE_FLUSH_PROMPT, IDLE_FLUSH_TIMEOUT_MS);
    if (result !== "completed") {
      process.stdout.write(`[${new Date().toISOString()}] idle-flush ${threadIdStr}: ${result} — leaving session intact\n`);
      return;
    }
    if (!daemonRegistry.isIdleEmpty(threadIdStr)) {
      process.stdout.write(`[${new Date().toISOString()}] idle-flush ${threadIdStr}: message arrived during flush — skipping clear\n`);
      return;
    }
    if (!rotateSessionUuid(key)) return;
    await daemonRegistry.resetTopic(threadIdStr);
    process.stdout.write(`[${new Date().toISOString()}] idle-cleared ${threadIdStr}: memory flushed → fresh session\n`);
  } catch (e) {
    process.stderr.write(`poller: idleFlushAndClear ${threadIdStr} failed: ${e instanceof Error ? e.message : String(e)}\n`);
  } finally {
    idleFlushing.delete(threadIdStr);
  }
}

// /clear over Telegram: rotate the per-topic session UUID and kill the
// topic's tmux session. The watchdog (kick_dead_topic_sessions) and the
// wrapper's restart loop respawn claude with the new UUID, so the next
// message starts a fresh conversation.
//
// Why we own this rather than forwarding to claude TUI: /clear is caught
// by the TUI layer, never reaches the model. Forwarding via tmux send-keys
// would clear claude's context but produce no send_telegram call — typing-
// keepalive would run to its 10-min cap with no user-visible feedback.
// We own the semantic so the user gets an explicit ack.
async function handleClear(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  const key = threadIdOf(ev);
  const mount = mountsCache.get(tgKey(key));

  if (!mount) {
    await reply(
      dest,
      "Nothing to clear — no project linked to this topic yet. Send a message and pick a directory from the buttons, or `cta mount <path>` from your Mac.",
    );
    return;
  }

  // Rotate per-topic session UUID. The new daemon (spawned by the registry
  // on the next enqueue) reads this file at start and uses --session-id with
  // a fresh UUID → no --resume → cold conversation.
  if (!rotateSessionUuid(key)) {
    await reply(
      dest,
      "Couldn't rotate the session UUID. Run `cta start` from your Mac to recover.",
    );
    return;
  }

  // Reset the registry entry so the running daemon stops and the next
  // enqueue lazy-spawns a fresh one with the rotated UUID. Without this,
  // the alive daemon keeps using the OLD UUID and /clear has no effect
  // until the poller restarts.
  if (daemonRegistry) {
    try {
      await daemonRegistry.resetTopic(String(key));
    } catch (e) {
      process.stderr.write(`poller: handleClear resetTopic failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  await reply(
    dest,
    "Cleared. New session starts on the next message (cold-start adds ~5–15s).",
  );
}

// ─── bot-side slash command handlers (stream-json migration Phase 1) ────────
// Replaces the picker-watcher's screen-scrape relay of /cost, /usage etc.
// — that approach was fragile across claude TUI version bumps (Format A's
// `⎿` marker vs Format B's `────` divider). Each of these handlers computes
// the answer directly from claude's on-disk state instead of parsing pane text.

/**
 * Resolve the JSONL transcript for the topic that produced this message.
 * Mirrors topic-wrapper.sh's resolution chain:
 *   1. Mount → project_path
 *   2. $STATE_DIR/sessions/<thread_id> → session UUID
 *   3. ~/.claude/projects/<encoded_cwd>/<uuid>.jsonl
 * Returns null if no mount or no session UUID is on disk yet (the topic
 * hasn't started its first claude turn, so there's nothing to bill).
 */
function jsonlPathForMount(mount: Mount): string | null {
  const key = mount.thread_id;
  const sessFile = join(sessionsDir(), String(key));
  if (!existsSync(sessFile)) return null;
  let uuid: string;
  try {
    uuid = readFileSync(sessFile, "utf8").trim();
  } catch { return null; }
  if (!uuid) return null;
  return jsonlPathForSession(mount.path, uuid);
}

async function handleCost(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  const key = threadIdOf(ev);
  const mount = mountsCache.get(tgKey(key));
  if (!mount) {
    await reply(
      dest,
      "No mount in this topic — nothing to bill. `/mount <path>` first.",
    );
    return;
  }
  const jsonl = jsonlPathForMount(mount);
  if (!jsonl) {
    await reply(
      dest,
      "Session hasn't started yet — send any message in this topic first, then try `/cost` again.",
    );
    return;
  }
  const summary = aggregateCostFromJsonl(jsonl);
  await reply(dest, formatCostMessage(summary));
}

// 60s cache for /usage — Anthropic's Usage API is rate-limited and the
// number doesn't move that fast. Identical pattern to teleclaw's 60s cache.
let usageCache: { stats: import("./slash-commands").UsageStats; expires: number } | null = null;
const USAGE_CACHE_MS = 60_000;

async function handleUsage(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  let stats: import("./slash-commands").UsageStats;
  if (usageCache && usageCache.expires > Date.now()) {
    stats = usageCache.stats;
  } else {
    const token = await resolveCredentialToken();
    if (!token) {
      await reply(
        dest,
        "Couldn't find claude code credentials on the host. Make sure you're signed in (`claude /login` on the Mac).",
      );
      return;
    }
    stats = await fetchUsageStats(token);
    usageCache = { stats, expires: Date.now() + USAGE_CACHE_MS };
  }
  await reply(dest, formatUsageMessage(stats));
}

/**
 * Kill the topic's tmux session — the wrapper's restart loop (or the
 * watchdog's kick_dead_topic_sessions) brings up a fresh claude that resumes
 * from the same session UUID. Different from `/clear`, which also rotates
 * the UUID for a brand-new conversation.
 */
async function handleRestartCmd(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  const key = threadIdOf(ev);
  const mount = mountsCache.get(tgKey(key));
  if (!mount) {
    await reply(
      dest,
      "Nothing to restart — no mount in this topic.",
    );
    return;
  }
  if (daemonRegistry) {
    try {
      await daemonRegistry.resetTopic(String(key));
    } catch (e) {
      process.stderr.write(`poller: handleRestart resetTopic failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  await reply(
    dest,
    "Restarting claude in this topic. First reply may take 5–15s while it cold-starts.",
  );
}

/**
 * Abort the in-flight claude turn for this topic. The session UUID is left
 * untouched, so the next message --resumes the same conversation — only the
 * running turn is dropped. Idempotent: replies "Nothing running to stop." when
 * no turn is in-flight.
 *
 * registry.stopTurn is graceful by default: it sends an in-band interrupt over
 * the daemon's stdin (stream-json control_request, verified claude v2.1.150) so
 * the subprocess STAYS ALIVE and the session continues — claude ends the current
 * turn and the next message reuses the warm daemon. It falls back to
 * SIGTERM→SIGKILL kill + lazy respawn only when the daemon/stdin is unavailable
 * or the interrupt write fails. The queue is preserved across the stop.
 */
async function handleStop(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  const key = threadIdOf(ev);
  const threadIdStr = String(key);

  let stopped = false;
  if (daemonRegistry) {
    try {
      stopped = await daemonRegistry.stopTurn(threadIdStr);
    } catch (e) {
      process.stderr.write(`poller: handleStop stopTurn failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // The aborted turn emits no turn-end, so onDaemonTurnEnd's clearTypingExternal
  // never fires — clear the typing indicator here so it doesn't keepalive to its
  // cap. (Read-ack glyphs need no handling: onDaemonFlush already flipped the
  // in-flight turn's messages to 👌 at flush time; messages queued during the
  // turn keep their 👀 and flip naturally when the resumed turn flushes.)
  if (isTyping(transport)) {
    void transport.clearTypingExternal(dest);
  }

  await reply(
    dest,
    stopped ? "⏹ Stopped." : "Nothing running to stop.",
  );
}

/**
 * Run `cta status` and post its output. The cta CLI knows about every
 * component (LaunchAgent, poller heartbeat, MCP, watchdog) — this is the
 * source of truth for "is the bot alive."
 */
async function handleStatusCmd(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  // cta lives at $HOME/.local/bin/cta in install.sh's layout; allow override
  // for tests. Plain status (no flags) prints the same checklist Pager menu
  // bar shows.
  const ctaPath = process.env.CTA_BIN ?? join(homedir(), ".local/bin/cta");
  const r = spawnSync(ctaPath, ["status"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 && !r.stdout) {
    await reply(
      dest,
      `Couldn't run cta status: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`,
    );
    return;
  }
  // cta status uses unicode glyphs (✓/✗) and color escapes; strip ANSI before
  // sending to Telegram. Cap to 3500 chars (Telegram plain text limit margin).
  let body = (r.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  if (body.length > 3500) body = body.slice(0, 3500) + "\n…(truncated)";
  await reply(
    dest,
    `cta status\n${body}`,
  );
}

// ─── in-chat commands (Phase 3) ──────────────────────────────────────────────
// The bot listens for /pair, /mount, /unmount, /list, /help in any message.
// Pre-pair state: only /pair <code> accepted, from any chat — once it matches
// the pairing code, we claim that chat as MAIN_CHAT_ID and that user as the
// allowlisted operator. Post-pair: only commands from the paired user are
// honored; everything else falls through to normal claude dispatch.

async function handlePair(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  if (!ev.from.id) return; // no sender (channel post); can't pair

  // Already-paired path: same operator (user_id) can re-pair anywhere with
  // no code — they've already proven ownership. /pair in a new chat just
  // switches the bot to that chat. /pair in the same chat is a no-op.
  // ev.from.id is the stringified sender; paired user_id is stored numeric.
  if (pairedCache) {
    if (ev.from.id !== String(pairedCache.user_id)) {
      // Different user trying to claim while paired. Stay silent.
      return;
    }
    if (chatIdOf(ev) === pairedCache.chat_id) {
      await reply(
        dest,
        "✓ Already paired here. Send any message to talk to claude.",
      );
      return;
    }
    // Switch to this chat. Old topic-* sessions still have the previous
    // chat_id pinned in their mcp-telegram env, so kill them — they'll
    // respawn on next dispatch via auto-respawn, picking up the new
    // paired.json's chat_id.
    const previousChatId = pairedCache.chat_id;
    const newState: PairedState = { ...pairedCache, chat_id: chatIdOf(ev), paired_at: new Date().toISOString() };
    writePairedAtomic(newState);
    pairedCache = newState;
    pairedMtimeMs = statSync(PAIRED_STATE_FILE).mtimeMs;
    await resetPerTopicStateOnPairSwitch();
    await ensureWildcardMount();
    await reply(
      dest,
      `✓ Switched to this chat (was chat ${previousChatId}). Send any message to talk to claude.`,
    );
    return;
  }

  // First-time pairing: requires a matching code from `cta pair-code`.
  let storedCode = "";
  try { storedCode = readFileSync(PAIRING_CODE_FILE, "utf8").trim(); } catch { /* fall through */ }
  if (!storedCode) {
    // No code on disk → either pairing already happened (and code was consumed)
    // or install hasn't run pair-code --init. Don't reveal which: stay silent.
    return;
  }
  const supplied = args.trim().toUpperCase();
  if (supplied !== storedCode.toUpperCase()) {
    await reply(
      dest,
      "Pairing code did not match. Lost it? Run `cta pair-code --reset` on the host.",
    );
    return;
  }
  // Match. Claim this chat + user, persist, delete the consumed code.
  const newState: PairedState = {
    version: 1,
    chat_id: chatIdOf(ev),
    user_id: Number(ev.from.id),
    paired_at: new Date().toISOString(),
  };
  writePairedAtomic(newState);
  try { unlinkSync(PAIRING_CODE_FILE); } catch { /* already gone */ }
  pairedCache = newState;
  pairedMtimeMs = statSync(PAIRED_STATE_FILE).mtimeMs;
  await ensureWildcardMount();
  await reply(
    dest,
    "✓ Paired. Send any message to talk to claude. To switch chats later, just send /pair in the new chat.",
  );
}

/** Tear down per-topic state when the paired chat changes. Daemons spawned
 * before the pair switch have the previous chat_id pinned in mcp-telegram's
 * env; the next message respawns them via the registry's lazy-spawn path,
 * picking up the new paired.json's chat_id. We also kill any leftover
 * `topic-*` tmux sessions from a stale pre-Phase-4 install (defensive). */
async function resetPerTopicStateOnPairSwitch(): Promise<void> {
  // Snapshot any in-flight queues before shutdown — otherwise a pair switch
  // mid-conversation silently drops the user's pending text. Map<threadId, []>
  // captures every non-empty queue across topics; we replay each into the
  // fresh registry below so respawn picks them up with the new chat_id.
  const queueSnapshot = new Map<string, string[]>();
  if (daemonRegistry) {
    for (const [threadId, queue] of daemonRegistry.snapshotQueues()) {
      if (queue.length > 0) queueSnapshot.set(threadId, queue);
    }
    // Shut down all daemons — they hold the old chat_id in their MCP env.
    // shutdown() awaits SIGTERM completion so claude releases its session
    // lock file cleanly before the next message re-spawns it.
    await daemonRegistry.shutdown();
    initDaemonRegistry(); // fresh registry, lazy respawn on next enqueue
    // Replay snapshotted messages into the new registry. Each enqueue arms
    // the debounce; the first inbound after pair switch combines with any
    // recovered text. Order within each topic is preserved.
    if (daemonRegistry !== null) {
      for (const [threadId, queue] of queueSnapshot) {
        for (const text of queue) {
          (daemonRegistry as ClaudeDaemonRegistry).enqueue(threadId, text);
        }
      }
    }
  }
}

async function handleMount(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  const path = args.trim().replace(/^~/, homedir());
  if (!path) {
    await reply(dest, "Usage: `/mount <path>` — e.g. `/mount ~/projects/iron-flow`");
    return;
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    await reply(
      dest,
      `Path \`${path}\` is not a directory on the Mac. Check spelling and that it exists locally.`,
    );
    return;
  }
  const thread_id = threadIdOf(ev);
  if (thread_id === "dm") {
    await reply(
      dest,
      "Send `/mount` inside a forum topic, or use `/dm <path>` here in DM.",
    );
    return;
  }
  // Reuse the mount-store CLI via subprocess — keeps the locking single-sourced.
  const storePath = process.env.MOUNT_STORE_PATH ?? installMountStoreTs();
  const r = spawnSync("bun", ["run", storePath, "add", String(thread_id), path], { encoding: "utf8" });
  if (r.status !== 0) {
    await reply(
      dest,
      `Mount failed: ${(r.stderr ?? "").trim() || "(no error)"}`,
    );
    return;
  }
  await reply(
    dest,
    [
      `✓ Mounted thread ${thread_id} → ${path}`,
      ``,
      `Send any message in this topic to start the claude session. \`cta start\` may be needed on the host if no poller is live yet (this one is, so you should be good).`,
    ].join("\n"),
  );
  // Trigger an immediate mounts.json reload (mtime-based; poller will pick
  // it up on next iter anyway, but explicit refresh shortens the window).
  refreshMountsIfChanged();
}

async function handleDm(ev: InboundMessageEvent, args: string): Promise<void> {
  // Equivalent to /mount but pins thread_id="dm" sentinel.
  const dest = ev.address;
  const path = args.trim().replace(/^~/, homedir());
  if (!path) {
    await reply(dest, "Usage: `/dm <path>` — sets the DM mount to the given Mac path.");
    return;
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    await reply(dest, `Path \`${path}\` is not a directory on the Mac.`);
    return;
  }
  const storePath = process.env.MOUNT_STORE_PATH ?? installMountStoreTs();
  const r = spawnSync("bun", ["run", storePath, "add", "dm", path], { encoding: "utf8" });
  if (r.status !== 0) {
    await reply(dest, `DM mount failed: ${(r.stderr ?? "").trim()}`);
    return;
  }
  await reply(dest, `✓ DM mount → ${path}. Send any message here to start the claude session.`);
  refreshMountsIfChanged();
}

async function handleUnmount(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  const key = String(threadIdOf(ev));
  const storePath = process.env.MOUNT_STORE_PATH ?? installMountStoreTs();
  const r = spawnSync("bun", ["run", storePath, "remove", key], { encoding: "utf8" });
  if (r.status !== 0) {
    await reply(dest, `Unmount failed: ${(r.stderr ?? "").trim()}`);
    return;
  }
  if ((r.stdout ?? "").trim() === "null") {
    await reply(dest, `Thread ${key} was not mounted.`);
    return;
  }
  await reply(dest, `✓ Unmounted thread ${key}.`);
  refreshMountsIfChanged();
}

async function handleList(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  const data = readMounts();
  if (data.mounts.length === 0) {
    await reply(dest, "No mounts yet. Send `/mount <path>` in a topic to add one.");
    return;
  }
  // Join with topics.json so users see "thread 42 (Plans)" instead of bare
  // "thread 42". Mirrors cta list's TOPIC column. Topics created before the
  // bot joined the group remain anonymous until renamed — Telegram API gap.
  const topics = readTopics().topics;
  const chatId = pairedCache?.chat_id;
  const isGroup = chatId !== undefined && chatId < 0;
  const lines = data.mounts.map((m) => {
    let nameSuffix = "";
    if (typeof m.thread_id === "number" && chatId !== undefined) {
      const cachedName = topics[`${chatId}/${m.thread_id}`]?.name;
      if (cachedName) nameSuffix = ` "${cachedName}"`;
    } else if (m.thread_id === "dm" && isGroup) {
      // In a group, "dm" mount catches messages from the General topic
      // (Telegram omits message_thread_id for General). Label it as such
      // so users don't see "DM" in a group context.
      nameSuffix = ` "General"`;
    }
    return `• thread ${m.thread_id}${nameSuffix} → ${m.path}${m.label ? ` (${m.label})` : ""}`;
  });
  await reply(dest, `Current mounts:\n${lines.join("\n")}`);
}

// Telegram-convention: every bot's first-touch UX is /start. Telegram clients
// auto-send /start when a user opens a new bot chat. Without a handler the
// bot looks dead to a first-time user.
async function handleStart(ev: InboundMessageEvent): Promise<void> {
  const dest = ev.address;
  if (pairedCache) {
    if (ev.from.id === String(pairedCache.user_id)) {
      // Paired owner came back. Just remind them of available commands.
      return handleHelp(ev);
    }
    // Random user opened the paired bot. Stay silent — don't leak that
    // anything exists.
    return;
  }
  // Unpaired. Tell them how to claim it.
  await reply(
    dest,
    [
      "👋 Hi. I'm a claude-code Telegram proxy waiting to be paired.",
      "",
      "If you installed me, your host should have shown an 8-char pairing code.",
      "Send `/pair YOUR-CODE` here to claim me.",
      "",
      "Lost the code? Run `cta pair-code --reset` on the host and try again.",
    ].join("\n"),
  );
}

async function handleUnpair(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  // Two-step confirmation. `/unpair confirm` actually releases; bare /unpair
  // just explains. Prevents accidental release if someone fat-fingers the
  // command in a busy chat.
  if (args.trim().toLowerCase() !== "confirm") {
    await reply(
      dest,
      [
        "Unpair releases this chat so a different chat can claim the bot.",
        "Mounts are wiped. To proceed, send: `/unpair confirm`",
        "",
        "Or run `cta unpair` on the host (with --keep-mounts to preserve mounts).",
      ].join("\n"),
    );
    return;
  }
  // Release. paired.json is owned solely by the poller, so unlink is safe;
  // mounts.json is shared with cta — use the mount-store `clear` op so the
  // wipe goes through the file lock (no torn writes if a concurrent
  // `cta mount` is mid-rename).
  try { unlinkSync(PAIRED_STATE_FILE); } catch { /* already gone */ }
  try {
    spawnSync("bun", ["run", installMountStoreTs(), "clear"], { encoding: "utf8" });
  } catch (e) {
    process.stderr.write(`poller: handleUnpair clearMounts failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  pairedCache = null;
  pairedMtimeMs = 0;
  refreshMountsIfChanged();
  await reply(
    dest,
    "✓ Unpaired. Re-add me to a chat for the auto-pair prompt, or send `/pair <code>` (run `cta pair-code` on the host).",
  );
}

async function handleHelp(ev: InboundMessageEvent): Promise<void> {
  await reply(
    ev.address,
    [
      "Mount commands:",
      "  /mount <path>   — bind THIS forum topic to a project dir on the Mac",
      "  /dm <path>      — bind your DM with the bot to a project dir",
      "  /unmount        — remove the mount for THIS topic (or DM)",
      "  /list           — show current mounts",
      "  /unpair confirm — release this chat so another can claim me",
      "",
      "Session commands (run on the topic's claude):",
      "  /cost           — token usage + estimated cost for this session",
      "  /usage          — Anthropic 5h/7d subscription usage",
      "  /clear          — reset the conversation (new session UUID)",
      `  /effort <level> — set reasoning effort for this topic (${EFFORT_NAMES})`,
      "  /model <name>   — set model for this topic (opus|sonnet|haiku|full-id)",
      "  /task           — scheduled tasks: list | run|on|off|rm <name>",
      "  /context        — approx context-window usage for this topic",
      "  /restart        — restart claude on this topic (keep session)",
      "  /stop           — abort the running turn (keeps session; queued messages stay)",
      "  /status         — show bot/daemon health (cta status output)",
      "",
      "Any non-command message is forwarded to the claude session for that mount.",
    ].join("\n"),
  );
}

// TUI command registry (P3.10 / Principle 6).
//
// Three dispositions for Claude Code TUI commands that arrive over Telegram:
//
//   translated  — has a poller-side handler that implements the semantic
//                 over Telegram. Pager owns the meaning; claude TUI's
//                 internal behavior is irrelevant.
//   hidden      — TUI-only command with no Telegram analog. Reply with a
//                 per-command reason so the user knows where to go on
//                 their Mac (vs. the previous generic "local UI command"
//                 message that gave no actionable guidance).
//   forwarded   — safe to forward to claude (default, no entry needed).
//                 User-defined skills like `/qa`, `/codex` rely on this.
//
// Adding a new command is one row. Future Claude Code releases that add
// commands need a one-line registry update — vs. the old hand-grown
// CLAUDE_BUILTIN_BLOCKLIST that silently fell out of sync.
type CommandSpec =
  | { disposition: "translated"; handler: (ev: InboundMessageEvent) => Promise<void> }
  | { disposition: "hidden"; reason: string };

const TUI_COMMANDS: Record<string, CommandSpec> = {
  // ── translated: bot-side handlers ─────────────────────────────────────────
  // Each computes the answer from claude's on-disk state (JSONL transcript,
  // keychain credentials, tmux session liveness) instead of screen-scraping
  // claude TUI output. See agent/poller/slash-commands.ts.
  "/clear":   { disposition: "translated", handler: (m) => handleClear(m) },
  "/cost":    { disposition: "translated", handler: (m) => handleCost(m) },
  "/usage":   { disposition: "translated", handler: (m) => handleUsage(m) },
  "/restart": { disposition: "translated", handler: (m) => handleRestartCmd(m) },
  "/status":  { disposition: "translated", handler: (m) => handleStatusCmd(m) },
  "/context": { disposition: "translated", handler: (m) => handleContext(m) },

  // ── hidden: TUI-only commands with no Telegram analog ─────────────────────
  "/config":      { disposition: "hidden", reason: "Edit `~/.pager/.env` directly, then `cta restart`." },
  "/agents":      { disposition: "hidden", reason: "Project agents live in `.claude/agents/` on disk." },
  "/permissions": { disposition: "hidden", reason: "Bot runs with `--dangerously-skip-permissions`; tools are constrained via `agent/helper-permissions.json`." },
  "/compact":     { disposition: "hidden", reason: "Claude Code auto-compacts; on-demand /compact isn't triggerable in the daemon (stream-json) mode. Use /clear to reset the conversation." },
  "/output-style":{ disposition: "hidden", reason: "Telegram renders plain text — output styles are TUI-only." },
  "/init":        { disposition: "hidden", reason: "Run on your Mac in the project directory." },
  "/exit":        { disposition: "hidden", reason: "Use `/clear` to reset the conversation, or `cta stop` / `cta start` on your Mac." },
  "/quit":        { disposition: "hidden", reason: "Use `/clear` to reset the conversation, or `cta stop` / `cta start` on your Mac." },
  "/logout":      { disposition: "hidden", reason: "The Telegram bot has no logout. `cta unpair` releases the chat for re-pairing." },
  "/login":       { disposition: "hidden", reason: "The Telegram bot has no login. Run `cta pair-code` on your Mac, then send `/pair <code>` here." },
};

async function handleHiddenTuiCommand(ev: InboundMessageEvent, command: string, reason: string): Promise<void> {
  await reply(
    ev.address,
    `\`${command}\` is a Claude Code TUI command — ${reason}`,
  );
}

/**
 * Attempt to handle a message as an in-chat command. Returns true if the
 * message was consumed by command handling (so normal tmux dispatch should
 * be skipped). Returns false to fall through to normal routing.
 *
 * Pre-pair: only /pair is accepted from any chat. Everything else returns
 * false (which then drops because there's no MAIN_CHAT_ID yet).
 * Post-pair: only the paired user_id gets commands honored; others fall
 * through. Unknown /commands also fall through (claude can handle them)
 * except for the blocklist of UI-only built-ins.
 */
async function tryHandleCommand(ev: InboundMessageEvent): Promise<boolean> {
  const text = ev.text;
  if (!text.startsWith("/")) return false;
  // `/pair@MyBot AB7K-...` → strip @-suffix from command word
  const firstSpace = text.indexOf(" ");
  const head = firstSpace < 0 ? text : text.slice(0, firstSpace);
  const command = head.split("@")[0].toLowerCase();
  const args = firstSpace < 0 ? "" : text.slice(firstSpace + 1);

  // Pre-pair: only /start and /pair are meaningful. Everything else falls
  // through (which then drops because there's no MAIN_CHAT_ID yet).
  if (!pairedCache && !ENV_MAIN_CHAT_ID) {
    if (command === "/pair") { await handlePair(ev, args); return true; }
    if (command === "/start") { await handleStart(ev); return true; }
    return false;
  }

  // Post-pair authorization: paired user_id only. ev.from.id is the stringified
  // sender id; the stored user_id is numeric, so compare as strings.
  if (pairedCache && ev.from.id !== String(pairedCache.user_id)) {
    // Silently drop — don't reveal command surface to unauthorized users.
    return command.startsWith("/"); // claim handled to suppress claude dispatch
  }

  switch (command) {
    case "/start": await handleStart(ev); return true;
    case "/pair":  await handlePair(ev, args); return true;
    case "/unpair": await handleUnpair(ev, args); return true;
    case "/mount": await handleMount(ev, args); return true;
    case "/dm":    await handleDm(ev, args); return true;
    case "/unmount": await handleUnmount(ev); return true;
    case "/stop":   await handleStop(ev); return true;
    case "/list":  await handleList(ev); return true;
    case "/effort": await handleEffort(ev, args); return true;
    case "/model": await handleModel(ev, args); return true;
    case "/do":    await handleDo(ev, args); return true;
    case "/task":  await handleTask(ev, args); return true;
    case "/help":  await handleHelp(ev); return true;
    default: {
      // TUI command framework: translated → run handler, hidden → reply,
      // forwarded (no entry) → fall through to claude.
      const spec = TUI_COMMANDS[command];
      if (spec?.disposition === "translated") {
        await spec.handler(ev);
        return true;
      }
      if (spec?.disposition === "hidden") {
        await handleHiddenTuiCommand(ev, command, spec.reason);
        return true;
      }
      return false; // unknown /x → let claude see it (user skills etc.)
    }
  }
}

// ─── update routing ──────────────────────────────────────────────────────────


// ─── mounts cache ────────────────────────────────────────────────────────────
// Hot-reload on mtime change so `cta mount/umount` is picked up without
// restarting the poller. Each iteration of the main loop calls
// refreshMountsIfChanged() — bounded work (one stat per loop), no inotify
// dependency, no polling thread.

let mountsCache: Map<string, Mount> = new Map();
let mountsMtimeMs = 0;

function refreshMountsIfChanged(): void {
  let mtimeMs = 0;
  try { mtimeMs = statSync(MOUNTS_JSON).mtimeMs; } catch { /* missing file → mtime stays 0 */ }
  if (mtimeMs === mountsMtimeMs) return;
  try {
    const data = readMounts();
    const next = new Map<string, Mount>();
    for (const m of data.mounts) next.set(mountKey(m.channel, m.thread_id), m);
    mountsCache = next;
    mountsMtimeMs = mtimeMs;
    process.stdout.write(`[${new Date().toISOString()}] mounts reloaded (${next.size} entries)\n`);
  } catch (e) {
    process.stderr.write(`poller: mounts.json reload failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * Look up the tmux session for an incoming message, or null to drop. Routing
 * keys:
 *   - forum topic → mount with thread_id == msg.message_thread_id
 *   - DM (no thread_id) → mount with thread_id == "dm"
 *
 * Chat-level allowlist (MAIN_CHAT_ID) is enforced first — replaces the
 * official plugin's allowFrom semantics in v0.
 */
/**
 * Persist a wildcard-derived mount for a thread_id that hit the `*` template.
 * Phase 4: only the mount-store record is created — there is no per-topic tmux
 * session to spawn, since claude lives inside the poller's ClaudeDaemonRegistry
 * and gets lazy-spawned on the next enqueue. Subsequent messages route directly
 * via the specific mount (wildcard is only consulted for unmounted threads).
 *
 * Returns the persisted `tmux_session` field (still recorded in mount-store
 * for legacy schema compatibility) on success, null on failure.
 */
async function autoSpawnFromWildcard(thread_id: number | "dm", templatePath: string): Promise<string | null> {
  try {
    // In-process addMount — was `spawnSync("bun","run","mount-store.ts","add")`,
    // whose ~100s-of-ms `bun` cold start blocked the inbound long-poll on the
    // FIRST message to any unmounted thread. addMount goes through the same
    // O_EXCL withLock, so it's race-safe and persists for restarts.
    const mount = await addMount({ thread_id, path: templatePath, label: "auto" });
    // Refresh local cache so subsequent messages find the new mount directly.
    refreshMountsIfChanged();
    process.stdout.write(`[${new Date().toISOString()}] wildcard auto-mount: thread ${thread_id} → ${templatePath} (${mount.tmux_session})\n`);
    return mount.tmux_session;
  } catch (e) {
    // Includes the "already mounted" race (a concurrent message won) — same
    // null result the old non-zero exit status produced.
    process.stderr.write(`poller: wildcard auto-mount failed for ${thread_id}: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

async function routeMessage(ev: InboundMessageEvent): Promise<string | null> {
  const chatId = chatIdOf(ev);
  const fromId = ev.from.id;
  const threadLabel = ev.routingKey === "dm" ? "-" : ev.routingKey;
  const dropLog = (reason: string) =>
    process.stderr.write(`poller: drop msg from chat=${chatId} user=${fromId} thread=${threadLabel} text=${JSON.stringify(ev.text.slice(0, 40))} reason=${reason}\n`);
  const expectedChat = effectiveChatId();
  if (expectedChat == null) {
    dropLog("unpaired-no-env");
    return null;
  }
  if (String(chatId) !== expectedChat) {
    dropLog(`wrong-chat (expected ${expectedChat})`);
    return null;
  }
  // Per-user enforcement: when paired, only the paired user's messages reach
  // claude. effectiveUserId is numeric; ev.from.id is stringified — compare as
  // strings.
  const expectedUser = effectiveUserId();
  if (expectedUser != null && fromId !== String(expectedUser)) {
    dropLog(`wrong-user (expected ${expectedUser})`);
    return null;
  }
  const key = threadIdOf(ev);
  const specific = mountsCache.get(tgKey(key));
  if (specific) return specific.tmux_session;

  // No specific mount — try the wildcard. Auto-spawns a real per-thread
  // mount + tmux session using the wildcard's path as the project dir.
  const wildcard = mountsCache.get(tgKey("*"));
  if (wildcard) {
    return await autoSpawnFromWildcard(key, wildcard.path);
  }
  return null;
}

// P6a: when a topic has no mount (and no wildcard), the poller offers a
// buttons prompt of known project dirs instead of spawning an interactive
// tmux mount-helper. No claude/helper daemon, no chicken-and-egg.
function mountBasename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
/** Deterministic candidate dir list (re-derived identically on the callback,
 *  so callback_data can index into it). Distinct existing mount paths + the
 *  default CLAUDE_CWD, capped for a tidy keyboard. */
function mountCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p?: string) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  for (const m of mountsCache.values()) add(m.path);
  add(process.env.CLAUDE_CWD);
  return out.slice(0, 6);
}
async function promptMountChoice(thread_id: number | "dm", chat_id: number, threadIdRaw: number | undefined): Promise<void> {
  const cands = mountCandidates();
  const tid = String(thread_id);
  if (cands.length === 0) {
    await reply(tgAddr(chat_id, threadIdRaw), "This topic isn't linked to a project yet. Send `/mount <path>` (e.g. `/mount ~/projects/foo`), or set it in Pager.");
    return;
  }
  const buttons = cands.map((p, i) => [{ text: mountBasename(p), callback_data: `mnt:${tid}:${i}` }]);
  await sendInlineKeyboard(chat_id, "This topic isn't linked to a project yet. Pick one, or send `/mount <path>`:", buttons);
}

/** Topic-name harvest from a normalized topic-created/topic-renamed event. The
 *  Bot API has no getForumTopic, so we record names opportunistically as the
 *  forum service messages fly past (Pager shows "topic 42 (Plans)"). The
 *  normalized event carries the name; chat_id + numeric thread_id come from the
 *  underlying service message. Runs regardless of pairing/routing (same as the
 *  pre-normalization harvest that lived inside dispatchUpdate). */
function recordTopicNameFromEvent(
  ev: Extract<InboundEvent, { kind: "topic-created" | "topic-renamed" }>,
): void {
  const u = ev.raw as TgUpdate;
  const msg = u.message ?? u.edited_message;
  if (!msg || msg.message_thread_id == null) return;
  recordTopicName(msg.chat.id, msg.message_thread_id, ev.name);
}

// Message dispatch on the NORMALIZED event. The onEvent entry (main()) routes by
// ev.kind, so membership (joined/removed), button-press (callback_query), and the
// topic-name harvest (topic-created/topic-renamed) are handled before this point;
// onInboundMessage sees only message-kind events. No raw Telegram fields — every
// field comes from the normalized event (text/address/routingKey/from/messageRef),
// so a second platform routes through the identical code.
async function onInboundMessage(ev: InboundMessageEvent): Promise<void> {
  // Agentic Edit capture: if the user tapped Edit on an approval card, their next
  // plain (non-command) message in that topic is the corrected params. Consume it
  // as the gate decision and stop — don't route it to the daemon. Only the paired
  // user can drive an edit (mirrors tryHandleCommand's gate).
  if (pendingAgenticEdit && ev.text && !ev.text.startsWith("/")
      && (!pairedCache || ev.from.id === String(pairedCache.user_id))) {
    const pe = pendingAgenticEdit;
    if (Date.now() > pe.expiresAt) {
      pendingAgenticEdit = null; // stale → fall through to normal handling
    } else if (String(threadIdOf(ev)) === pe.threadId) {
      const updatedArgs = applyEdit(pe.tool, pe.args, ev.text.trim());
      writeDecision(APPROVALS_DIR, pe.id, { decision: "edit", at: new Date().toISOString(), updatedArgs });
      pendingAgenticEdit = null;
      await reply(ev.address, `✏️ Using your edit: ${ev.text.trim().slice(0, 180)}`);
      return;
    }
  }

  // Commands run first. Pre-pair /pair messages bypass MAIN_CHAT_ID gating
  // (that's the whole point — we don't know the chat yet). Post-pair commands
  // are gated by paired user_id inside tryHandleCommand.
  if (await tryHandleCommand(ev)) return;

  const text0 = ev.text;
  if (text0.length === 0) {
    process.stderr.write(`poller: ${ev.routingKey}: empty text, dropping\n`);
    return;
  }

  // Resolve which mount this message belongs to. routeMessage handles the
  // chat/user gating + drop logging; we re-check the gate here (cheaply) so a
  // dropped message logs once and returns without touching the registry.
  const expectedChat = effectiveChatId();
  if (expectedChat == null || String(chatIdOf(ev)) !== expectedChat) {
    void routeMessage(ev); // logs the drop reason
    return;
  }
  const expectedUser = effectiveUserId();
  if (expectedUser != null && ev.from.id !== String(expectedUser)) {
    void routeMessage(ev);
    return;
  }
  const routeKey = threadIdOf(ev);
  let mount = mountsCache.get(tgKey(routeKey));
  if (!mount) {
    // No specific mount — try wildcard auto-spawn (existing behavior).
    const wildcard = mountsCache.get(tgKey("*"));
    if (wildcard) {
      const spawned = await autoSpawnFromWildcard(routeKey, wildcard.path);
      if (spawned) {
        mount = mountsCache.get(tgKey(routeKey)); // refreshMountsIfChanged ran inside autoSpawn
      }
    }
  }
  if (!mount) {
    // P6a: no mount and no wildcard — offer a buttons prompt of known project
    // dirs (poller-only) instead of spawning the interactive tmux mount-helper.
    // The user taps a dir (or sends /mount), then resends their message.
    const threadIdRaw = routeKey === "dm" ? undefined : routeKey;
    await promptMountChoice(routeKey, chatIdOf(ev), threadIdRaw);
    return;
  }

  // Phase 4: single dispatch path through the ClaudeDaemonRegistry.
  // The registry owns spawn-if-needed, 2s debounce, per-topic queue, and
  // crash respawn. Reply text streams back asynchronously via the
  // postTelegramTextFromDaemon callback wired in initDaemonRegistry().
  // Fire-and-forget: daemonDispatch awaits the delivered-ack internally before
  // enqueue, but the caller need not block on it.
  void daemonDispatch(ev.routingKey, ev);
  process.stdout.write(`[${new Date().toISOString()}] msg → daemon[${ev.routingKey}] (${text0.length} chars)\n`);
}


// ─── main loop ───────────────────────────────────────────────────────────────

/**
 * Verify the bot token works before entering the long-poll loop. Without this
 * preflight, a bad token causes getUpdates to 401-loop silently in the
 * 5-second retry — the user sees "Waiting for /pair..." that never resolves
 * because the bot can't actually fetch messages. Surface the failure once,
 * with a remediation hint, then exit and let launchd respawn.
 */
async function preflightBotToken(): Promise<void> {
  try {
    const json = await getMe();
    if (!json.ok) {
      process.stderr.write(`poller: bot token rejected by Bot API: ${json.description ?? "(no description)"}\n`);
      process.stderr.write(`poller: edit $HOME/.claude/channels/telegram/.env and rerun ./install.sh\n`);
      process.exit(1);
    }
    botUserId = json.result?.id ?? null; // captured for my_chat_member filtering
    process.stdout.write(`[${new Date().toISOString()}] preflight ok: @${json.result?.username ?? "?"} (id=${botUserId})\n`);
  } catch (e) {
    // Network failure → don't exit (transient). Just warn.
    process.stderr.write(`poller: getMe preflight failed (will retry in main loop): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// The "/" autocomplete menu Telegram shows. Static operational commands the
// paired operator uses most; pairing/edge commands (/pair, /unpair, /start)
// are intentionally omitted to keep the menu focused — they still work
// when typed. Registered once at boot via setMyCommands (default scope).
const BOT_COMMAND_MENU = [
  { command: "help",    description: "Show available commands" },
  { command: "list",    description: "Show current project mounts" },
  { command: "mount",   description: "Bind this topic to a project folder" },
  { command: "dm",      description: "Bind your DM to a project folder" },
  { command: "unmount", description: "Remove this topic's mount" },
  { command: "clear",   description: "Reset the conversation (new session)" },
  { command: "stop",    description: "Abort the running turn (keep session)" },
  { command: "restart", description: "Restart claude on this topic" },
  { command: "cost",    description: "Token usage + estimated cost this session" },
  { command: "usage",   description: "Anthropic 5h / 7d subscription usage" },
  { command: "status",  description: "Bot and daemon health" },
  { command: "context", description: "Approx context-window usage for this topic" },
  { command: "effort",  description: `Set reasoning effort (${EFFORT_NAMES})` },
  { command: "model",   description: "Set model (opus|sonnet|haiku|full-id)" },
  { command: "do",      description: "Delegate a task — I act, asking before risky steps" },
  { command: "task",    description: "Scheduled tasks: list / run / on / off / rm" },
];

/** Publish the "/" command menu once at boot. Best-effort — a failure just
 *  means no autocomplete menu; every command still works when typed. */
async function registerBotCommands(): Promise<void> {
  await setMyCommands(BOT_COMMAND_MENU);
  process.stdout.write(`[${new Date().toISOString()}] registered ${BOT_COMMAND_MENU.length} bot commands (/ menu)\n`);
}

// ─── H2 digest dispatcher ────────────────────────────────────────────────────
// Called from housekeep on every tick. For each mount where digest.enabled is
// true, call shouldFire(). On fire=true: persist firedToday BEFORE spawning
// (write-through so a crash mid-fire is still "done for today"), spawn
// runHeartbeat detached, on completion log + reply if status="sent".
//
// Detached: fires never block the housekeep tick. The next tick re-enters
// digestDispatch and finds the in-flight mount via digestInFlight, skipping
// without a re-spawn.
// ─── Agentic 秘書 mode ────────────────────────────────────────────────────────
// A SEPARATE ephemeral executor (mirrors the heartbeat runner) spawns a
// tool-enabled `claude` gated by a PreToolUse hook: reversible work runs
// silently, irreversible/outward work pauses for a Telegram Approve/Edit/Reject.
// The poller services the approval round-trip on the housekeep tick and on
// button taps. Nothing here touches the interactive daemon's state machine.
const APPROVALS_DIR = join(STATE_DIR, "approvals");
const AGENTIC_SESSIONS_DIR = join(STATE_DIR, "agentic-sessions");
const AGENTIC_LOG_DIR = join(STATE_DIR, "agentic-log");
const AGENTIC_SETTINGS_FILE = join(STATE_DIR, "agentic-settings.json");
/** Topics with an agentic run in flight (one task per topic at a time). */
const agenticInFlight = new Set<string>();
/** Approval requests already rendered to Telegram this process (sync double-send guard). */
const approvalsSent = new Set<string>();
/** When the user taps Edit, the next plain message in that topic supplies corrected params. */
let pendingAgenticEdit:
  | { id: string; threadId: string; tool: string; args: Record<string, unknown>; expiresAt: number }
  | null = null;

/** Write the static --settings file that wires the gate hook on PreToolUse for
 *  ALL tools (matcher "*", verified to fire for every tool type). Idempotent. */
function ensureAgenticSettings(): void {
  const hookPath = defaultHookScriptPath();
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `bun ${JSON.stringify(hookPath)}`, timeout: 300 }] },
      ],
    },
  };
  const json = JSON.stringify(settings, null, 2);
  try {
    if (existsSync(AGENTIC_SETTINGS_FILE) && readFileSync(AGENTIC_SETTINGS_FILE, "utf8") === json) return;
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(AGENTIC_SETTINGS_FILE, json, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`poller: agentic settings write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Housekeep tick: render a recommendation-packet card for each pending approval
 *  request the gate hook has written, and reap expired ones. Mirrors digestDispatch. */
function approvalDispatch(): void {
  let reqs: ApprovalRequest[];
  try { reqs = listRequests(APPROVALS_DIR); } catch { return; }
  const now = Date.now();
  for (const req of reqs) {
    if (now > req.expiresAt) { approvalsSent.delete(req.id); cleanupApproval(APPROVALS_DIR, req.id); continue; }
    if (req.status === "sent" || approvalsSent.has(req.id)) continue;
    approvalsSent.add(req.id); // sync guard so the next 5s tick can't double-send
    const threadIdNum = req.threadId === "dm" ? undefined : Number(req.threadId);
    void sendInlineKeyboard(req.chatId, renderApprovalCard(req), approvalButtonRows(req.id), threadIdNum)
      .then((res) => { if (res) markSent(APPROVALS_DIR, req.id); else approvalsSent.delete(req.id); })
      .catch(() => { approvalsSent.delete(req.id); });
  }
}

/** Spawn the gated agentic executor for `task` in `threadId`'s mount, streaming
 *  progress back to the chat. Detached — never blocks the caller. */
async function launchAgentic(threadId: string, chatId: number, task: string, dest: ChatAddress, runOpts?: { systemPrompt?: string; model?: string; effort?: string; sessionKey?: string; notifyOnlyIf?: string; taskName?: string }): Promise<void> {
  if (agenticInFlight.has(threadId)) {
    await reply(dest, "I'm still working on a task in this topic — let me finish this one first.");
    return;
  }
  const key = threadId === "dm" ? "dm" : Number(threadId);
  const mount = mountsCache.get(tgKey(key)) ?? mountsCache.get(tgKey("*"));
  const mountPath = mount?.path ?? process.env.CLAUDE_CWD ?? process.cwd();

  ensureAgenticSettings();
  try {
    mkdirSync(APPROVALS_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(AGENTIC_SESSIONS_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(AGENTIC_LOG_DIR, { recursive: true, mode: 0o700 });
  } catch { /* best effort */ }

  // Session UUID for --resume continuity (first run --session-id creates it).
  // sessionKey defaults to the topic; scheduled tasks pass "task-<name>" so
  // each task keeps its own cross-day context. NOTE: threadId stays the real
  // topic — it drives mount lookup, approval-card routing, and the in-flight
  // guard; only the session FILE is per-task.
  const sessionKey = runOpts?.sessionKey ?? threadId;
  const sessionFile = join(AGENTIC_SESSIONS_DIR, sessionKey);
  let sessionUuid: string;
  let resumeExisting: boolean;
  try {
    sessionUuid = readFileSync(sessionFile, "utf8").trim();
    if (!sessionUuid) throw new Error("empty");
    resumeExisting = true;
  } catch {
    sessionUuid = randomUUID();
    resumeExisting = false;
    try { writeFileSync(sessionFile, sessionUuid + "\n", { mode: 0o600 }); } catch { /* continue */ }
  }

  agenticInFlight.add(threadId);
  // Conditional-notify tasks must produce ZERO messages on a quiet day — so
  // suppress the ack AND buffer the stream, delivering only if the final text
  // carries the marker. Normal runs ack + stream live as before.
  const notifyOnlyIf = runOpts?.notifyOnlyIf;
  const taskName = runOpts?.taskName;
  if (!notifyOnlyIf) {
    await reply(dest, "🤖 On it — I'll handle the safe steps myself and ask before anything risky.");
  }
  // Pin model/effort at dispatch time so a settings reload mid-run can't make
  // the result log misattribute the run. Per-task overrides win over globals.
  const model = runOpts?.model ?? agenticModel;
  const effort = runOpts?.effort ?? agenticEffort;
  process.stdout.write(`[${new Date().toISOString()}] agentic dispatch: thread=${threadId} mount=${mountPath} model=${model ?? "default"} effort=${effort ?? "default"} task="${task.slice(0, 80)}"\n`);

  void (async () => {
    let streamedAny = false;
    const buf: string[] = [];
    try {
      const doRun = (uuid: string, resume: boolean) => runAgentic({
        mountPath,
        threadId,
        chatId,
        task,
        model,
        effort,
        systemPrompt: runOpts?.systemPrompt,
        approvalsDir: APPROVALS_DIR,
        settingsPath: AGENTIC_SETTINGS_FILE,
        sessionUuid: uuid,
        resumeExisting: resume,
        logFile: join(AGENTIC_LOG_DIR, `${sessionKey}.jsonl`),
        // Conditional → buffer (decide at end). Normal → stream live.
        onText: (t) => { streamedAny = true; if (notifyOnlyIf) buf.push(t); else void reply(dest, t); },
      });
      let result = await doRun(sessionUuid, resumeExisting);
      // Self-heal: a --resume can hit an unusable session — the conversation was
      // deleted (mount cwd changed), or it's pinned to a model that's since gone
      // unavailable (e.g. an access-gated model). claude exits 1 every cycle and a
      // scheduled task would fail forever. Drop the pointer and retry ONCE on a
      // fresh session so it recovers silently — no scary error at startup. Only
      // safe because such errors die before streaming any output (streamedAny
      // stays false; buf empty), so the retry can't duplicate user-visible text.
      if (result.status === "error" && resumeExisting && !streamedAny
          && isSessionUnusableError(result.errorMessage)) {
        process.stdout.write(`[${new Date().toISOString()}] agentic self-heal: session=${sessionKey} unusable (${result.errorMessage}) — recreating fresh\n`);
        try { unlinkSync(join(AGENTIC_SESSIONS_DIR, sessionKey)); } catch { /* gone */ }
        const freshUuid = randomUUID();
        try { writeFileSync(join(AGENTIC_SESSIONS_DIR, sessionKey), freshUuid + "\n", { mode: 0o600 }); } catch { /* continue */ }
        result = await doRun(freshUuid, false);
      }
      process.stdout.write(`[${new Date().toISOString()}] agentic result: thread=${threadId} status=${result.status} model=${model ?? "default"} effort=${effort ?? "default"} cost=$${result.totalCostUsd.toFixed(4)} dur=${result.durationMs}ms\n`);
      let suppressed = false;
      if (result.status === "error") {
        await reply(dest, `⚠️ Agentic run failed: ${result.errorMessage ?? "unknown error"}`);
      } else if (result.status === "timeout") {
        await reply(dest, "⏱ Agentic run hit its time budget and stopped.");
      } else if (notifyOnlyIf) {
        // Deliver the buffered briefing only if it carries the marker; a quiet
        // day stays silent (no ack was sent either).
        const text = buf.join("");
        if (text.includes(notifyOnlyIf)) await reply(dest, text);
        else { suppressed = true; process.stdout.write(`[${new Date().toISOString()}] task notify suppressed: ${taskName ?? threadId} (no "${notifyOnlyIf}")\n`); }
      } else if (!streamedAny) {
        await reply(dest, "✅ Check-in done — nothing to report.");
      }
      // "done" with streamed text (non-conditional): already went out via onText.
      if (taskName) recordTaskRun(taskName, result.status, suppressed);
    } catch (e) {
      await reply(dest, `⚠️ Agentic run crashed: ${e instanceof Error ? e.message : String(e)}`);
      if (taskName) recordTaskRun(taskName, "crashed", false);
    } finally {
      agenticInFlight.delete(threadId);
    }
  })();
}

async function handleDo(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  const task = args.trim();
  if (!task) {
    await reply(dest, "Usage: /do <task> — e.g. `/do triage the failing test and propose a fix`. I'll act on the reversible steps and ask before anything risky (push, merge, delete, send).");
    return;
  }
  await launchAgentic(String(threadIdOf(ev)), dest.chatId, task, dest);
}

/** /task over Telegram — the chat-side handle on tasks.json. list / run / on /
 *  off / rm cover the daily-driver needs; add/edit stay in the richer UIs
 *  (Pager app Tasks tab, `cta task add`). Mutations go through tasks-store's
 *  locked writers; the mtime bump makes refreshTasksIfChanged pick them up. */
async function handleTask(ev: InboundMessageEvent, args: string): Promise<void> {
  const dest = ev.address;
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "list";
  const name = parts[1] ?? "";
  refreshTasksIfChanged();

  if (sub === "list") {
    if (tasksCache.length === 0) {
      await reply(dest, "No scheduled tasks yet. Add one from the Pager app's Tasks tab or `cta task add …`.");
      return;
    }
    const lines = tasksCache.map((t) => {
      const days = Array.isArray(t.days) ? t.days.join(",") : t.days;
      const src = t.checklist ? (t.checklist.split("/").pop() ?? "checklist") : "inline";
      const last = formatLastRun(t.name);
      return `${t.enabled ? "🟢" : "⚪️"} ${t.name} — ${t.time} ${days} → ${String(t.topic)} (${src})${last ? `\n   last: ${last}` : ""}`;
    });
    await reply(dest, ["Scheduled tasks:", ...lines, "", "Manage: /task run|on|off|rm <name>"].join("\n"));
    return;
  }

  if (!["run", "on", "off", "rm"].includes(sub)) {
    await reply(dest, "Usage: /task [list] | /task run <name> | /task on <name> | /task off <name> | /task rm <name>");
    return;
  }
  if (!name) {
    await reply(dest, `Usage: /task ${sub} <name> — see /task list`);
    return;
  }
  // Existence check doubles as name sanitization: only names that passed
  // tasks-store validation at add time can match, so `name` is safe to use
  // as the run-now flag filename below.
  const task = tasksCache.find((t) => t.name === name);
  if (!task) {
    await reply(dest, `No task named "${name}" — see /task list`);
    return;
  }

  try {
    switch (sub) {
      case "run": {
        mkdirSync(TASK_RUN_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(join(TASK_RUN_DIR, name), "");
        await reply(dest, `▶️ Queued "${name}" — fires on the next tick (~5s).`);
        return;
      }
      case "on":
      case "off": {
        await setTaskEnabled(name, sub === "on");
        await reply(dest, `${sub === "on" ? "🟢 enabled" : "⚪️ disabled"} "${name}".`);
        return;
      }
      case "rm": {
        await removeTask(name);
        await reply(dest, `🗑 Removed "${name}".`);
        return;
      }
    }
  } catch (e) {
    await reply(dest, `⚠️ /task ${sub} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Scheduled tasks (proactive task scheduling) ─────────────────────────────
// tasks.json (tasks-store) is the first-class schedule: each task fires a
// gated agentic run at its own time/days into its own topic. This REPLACED
// the legacy "daily digest" (single global digestTime, read-only open-prs
// summary) on 2026-06-10 — the morning briefing is simply task #1.

/** Canonical task state key → firedToday rows "task:<name>:<ymd>" (cannot
 *  collide with the legacy digest's "<threadId>:<ymd>" rows). */
function taskKey(name: string): string { return `task:${name}`; }
/** Per-task agentic-session filename. Distinct from the per-topic key so two
 *  tasks on one topic don't share --resume context; the topic-level
 *  agenticInFlight guard still serializes them at run time. */
function taskSessionKey(name: string): string { return `task-${name}`; }

// Last-run record per task: $STATE_DIR/task-runs/<name>.json = { at, status,
// suppressed }. Cosmetic history for `cta task list` / the app — best-effort.
const TASK_RUNS_DIR = join(STATE_DIR, "task-runs");
function recordTaskRun(name: string, status: string, suppressed: boolean): void {
  try {
    mkdirSync(TASK_RUNS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(TASK_RUNS_DIR, `${name}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), status, suppressed })}\n`, { mode: 0o600 });
  } catch { /* history is cosmetic — never block a run on it */ }
}

/** Human one-liner for a task's last run (status icon + relative time), or ""
 *  when it has never fired. Read by /task list. */
function formatLastRun(name: string): string {
  let rec: { at?: string; status?: string; suppressed?: boolean };
  try { rec = JSON.parse(readFileSync(join(TASK_RUNS_DIR, `${name}.json`), "utf8")); }
  catch { return ""; }
  if (!rec.at) return "";
  const icon = rec.status === "done" ? (rec.suppressed ? "🔕" : "✅")
    : rec.status === "timeout" ? "⏱"
    : "⚠️";
  const ageMs = Date.now() - new Date(rec.at).getTime();
  const mins = Math.round(ageMs / 60_000);
  const ago = mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `${icon} ${ago}${rec.suppressed ? " (quiet)" : ""}`;
}

// tasks.json hot-reload cache (mirrors refreshMountsIfChanged: mtime-gated,
// parse failure keeps the last good cache).
let tasksCache: ScheduledTask[] = [];
let tasksMtimeMs = -1;
const TASKS_FILE = tasksJson();
const TASK_RUN_DIR = taskRunDir();
function refreshTasksIfChanged(): void {
  let mtimeMs = 0;
  try { mtimeMs = statSync(TASKS_FILE).mtimeMs; } catch { /* missing → empty store */ }
  if (mtimeMs === tasksMtimeMs) return;
  try {
    tasksCache = readTasks().tasks;
    tasksMtimeMs = mtimeMs;
    process.stdout.write(`[${new Date().toISOString()}] tasks reloaded (${tasksCache.length} entries)\n`);
  } catch (e) {
    tasksMtimeMs = mtimeMs;
    process.stderr.write(`poller: tasks.json reload failed (keeping ${tasksCache.length} cached): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Resolve a task's target topic to its mount, or null when unmounted (a task
 *  may only fire into a real mounted topic — launchAgentic's wildcard/cwd
 *  fallback would silently run in the wrong directory). */
function resolveTaskTopic(task: ScheduledTask): { threadIdStr: string; mount: Mount } | null {
  const key = task.topic === "dm" ? ("dm" as const) : Number(task.topic);
  const mount = mountsCache.get(tgKey(key));
  if (!mount) return null;
  return { threadIdStr: String(task.topic), mount };
}

/** Build the prompt for a scheduled task. Inline `prompt` is used verbatim;
 *  a `checklist` file is injected whole. Missing/unreadable checklist → null:
 *  the caller skips the fire and warns — NEVER falls back to open-ended
 *  secretary framing on an unattended run (that framing's exploration is
 *  exactly what stalls on the approval gate with nobody awake). */
function buildTaskPrompt(task: ScheduledTask): string | null {
  let body: string | null = null;
  if (task.prompt) {
    body = task.prompt;
  } else {
    try {
      const md = readFileSync(task.checklist ?? "", "utf8").trim();
      if (md) body = md;
    } catch { /* missing → null */ }
  }
  if (!body) return null;
  return [
    `Scheduled task "${task.name}" (I didn't prompt you just now — this is the scheduled fire).`,
    "The instructions below are the ENTIRE job. Follow them exactly; do not do anything else.",
    "",
    body,
  ].join("\n");
}

/** Digest-only system prompt for the UNATTENDED scheduled fire. Replaces the
 *  open-ended secretary SYSTEM_PROMPT (agentic-runner.ts) whose "delegated
 *  task" framing made the agent explore (git/PRs/--help probes with shell
 *  metachars) — each probe gate-ASKed and stalled the run with nobody awake
 *  to approve. Keeps the gate contract; cuts the exploration license. */
const DIGEST_ONLY_SYSTEM_PROMPT = [
  "You are running an UNATTENDED scheduled briefing. Nobody is watching; an approval request would stall until it times out.",
  "A safety gate fronts every tool call: read-only / in-project actions run automatically; anything it can't prove safe pauses for approval. Therefore make ONLY plainly-safe calls: no shell metacharacters (no pipes, redirects, $(), parens, 2>&1), one simple command per Bash call, and prefer dedicated tools (Read, WebFetch, MCP) over shell.",
  "Execute the checklist you are given EXACTLY — it is the entire job. Do NOT explore beyond it: no git/PR/CI checks, no --help probes, no extra investigation.",
  "If a step would need approval, skip it, note '(skipped)' for that section, and continue. Never wait on the gate.",
  "Telegram renders your text as plain text — no markdown. Your streamed text IS the delivered briefing; always end with the briefing message itself.",
].join("\n");

/** Scheduled-task dispatcher — runs every housekeep tick; fires each enabled
 *  task at its own time/days through the gated agentic executor with the
 *  digest-only system prompt. Busy topic → shouldFireTask returns in-flight
 *  and the task DEFERS to the next tick (it is NOT marked fired — marking
 *  happens only on actual hand-off, so a busy morning can't silently eat the
 *  briefing for the day). */
const taskWarnedOnce = new Set<string>();
function taskDispatch(): void {
  const chatIdStr = effectiveChatId();
  if (!chatIdStr) return;
  const chatId = Number(chatIdStr);
  if (!Number.isFinite(chatId)) return;

  const now = new Date();

  for (const task of tasksCache) {
    if (task.enabled !== true) continue;
    const resolved = resolveTaskTopic(task);
    if (!resolved) {
      if (!taskWarnedOnce.has(task.name)) {
        taskWarnedOnce.add(task.name);
        process.stderr.write(`poller: task "${task.name}" targets unmounted topic ${String(task.topic)} — skipping until mounted\n`);
      }
      continue;
    }
    const { threadIdStr, mount } = resolved;
    const key = taskKey(task.name);
    const dest: ChatAddress = {
      channel: "telegram",
      chatId,
      threadId: typeof mount.thread_id === "number" ? mount.thread_id : undefined,
    };

    // Missed-day alert (one-shot; day-aware so a weekdays task never
    // false-alarms about the correctly-skipped Sunday).
    const missedYmd = detectMissedTaskFire({
      state: heartbeatState, taskKey: key, days: task.days, timezone: digestTimezone, now,
    });
    if (missedYmd) {
      heartbeatState = markFiredToday(heartbeatState, key, missedYmd);
      try { writeHeartbeatState(heartbeatState); } catch { /* best effort */ }
      process.stdout.write(`[${new Date().toISOString()}] task missed-fire: task=${task.name} ymd=${missedYmd}\n`);
      void reply(dest, `⚠️ task "${task.name}" は ${missedYmd} に発火しませんでした(おそらく ${task.time} 時点で Mac がスリープ)。今日の分は通常どおり走ります。`);
    }

    const decision = shouldFireTask({
      state: heartbeatState,
      taskKey: key,
      time: task.time,
      days: task.days,
      quietHours: digestQuietHours,
      timezone: digestTimezone,
      isInFlight: () => agenticInFlight.has(threadIdStr),
      isMidTurn: () => {
        // getStatus returns the literal string "absent" for an unknown thread,
        // NOT null — a null check here silently skipped every fire on a fresh
        // boot (same gotcha the digest dispatcher hit on first live setup).
        if (!daemonRegistry) return false;
        const s = daemonRegistry.getStatus(threadIdStr);
        return s !== "absent" && s !== "idle";
      },
      now,
    });
    if (!decision.fire) continue;

    const prompt = buildTaskPrompt(task);
    if (prompt === null) {
      // Missing checklist: mark fired (don't hammer retries all day) + warn.
      heartbeatState = markFiredToday(heartbeatState, key, decision.ymd);
      try { writeHeartbeatState(heartbeatState); } catch { /* best effort */ }
      void reply(dest, `⚠️ task "${task.name}": checklist が読めません (${task.checklist ?? "?"}) — 今日の実行をスキップ。`);
      continue;
    }

    // Write-through BEFORE spawn: a crash during fire counts as "fired today"
    // (no same-day double-send).
    heartbeatState = markFiredToday(heartbeatState, key, decision.ymd);
    try { writeHeartbeatState(heartbeatState); }
    catch (e) {
      process.stderr.write(`poller: heartbeat-state persist failed (continuing): ${e instanceof Error ? e.message : String(e)}\n`);
    }

    process.stdout.write(`[${new Date().toISOString()}] task dispatch: task=${task.name} topic=${threadIdStr} mount=${mount.path}\n`);
    void launchAgentic(threadIdStr, chatId, prompt, dest, {
      systemPrompt: DIGEST_ONLY_SYSTEM_PROMPT,
      model: task.model,
      effort: task.effort,
      sessionKey: taskSessionKey(task.name),
      notifyOnlyIf: typeof task.notifyOnlyIf === "string" ? task.notifyOnlyIf : undefined,
      taskName: task.name,
    });
  }
}

/** Manual "run now": `cta task run <name>` touches $STATE_DIR/task-run/<name>;
 *  consume on the next tick (unlink BEFORE firing — a crash drops the request,
 *  never replays it; same contract as processInjectFlags). Bypasses the
 *  time/day/firedToday gates but NOT the topic's in-flight guard, and does NOT
 *  markFiredToday — the scheduled fire is still owed. */
let taskRunSweepInFlight = false;
function processTaskRunFlags(): void {
  if (taskRunSweepInFlight) return;
  taskRunSweepInFlight = true;
  try {
    let names: string[] = [];
    try {
      names = require("node:fs").readdirSync(TASK_RUN_DIR) as string[];
    } catch { return; } // dir absent → nothing queued
    if (names.length === 0) return;
    const chatIdStr = effectiveChatId();
    if (!chatIdStr) return;
    const chatId = Number(chatIdStr);
    for (const name of names) {
      if (name.startsWith(".")) continue; // skip .DS_Store etc. (Finder-touched dirs)
      try { unlinkSync(join(TASK_RUN_DIR, name)); } catch { continue; }
      const task = tasksCache.find((t) => t.name === name);
      if (!task) {
        process.stderr.write(`poller: task-run flag for unknown task "${name}" — ignored\n`);
        continue;
      }
      const resolved = resolveTaskTopic(task);
      if (!resolved) continue;
      const dest: ChatAddress = {
        channel: "telegram",
        chatId,
        threadId: typeof resolved.mount.thread_id === "number" ? resolved.mount.thread_id : undefined,
      };
      const prompt = buildTaskPrompt(task);
      if (prompt === null) {
        void reply(dest, `⚠️ task "${task.name}": checklist が読めません (${task.checklist ?? "?"}) — run-now を中止。`);
        continue;
      }
      process.stdout.write(`[${new Date().toISOString()}] task run-now: task=${task.name} topic=${resolved.threadIdStr}\n`);
      // Manual run-now ALWAYS delivers (the user asked for it) — no notifyOnlyIf
      // suppression — but still records the run.
      void launchAgentic(resolved.threadIdStr, chatId, prompt, dest, {
        systemPrompt: DIGEST_ONLY_SYSTEM_PROMPT,
        model: task.model,
        effort: task.effort,
        sessionKey: taskSessionKey(task.name),
        taskName: task.name,
      });
    }
  } finally {
    taskRunSweepInFlight = false;
  }
}

export async function main(): Promise<void> {
  // Install signal handlers BEFORE any work — if SIGTERM arrives during
  // preflight/initDaemonRegistry, default node behavior is silent exit,
  // which would orphan partly-spawned daemons holding session locks.
  // The handler is null-safe against `daemonRegistry` not being constructed
  // yet because the void-IIFE checks `if (daemonRegistry)`.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      process.stdout.write(`[${new Date().toISOString()}] poller: ${sig} received — shutting down daemons\n`);
      void (async () => {
        if (daemonRegistry) await daemonRegistry.shutdown();
        process.exit(0);
      })();
    });
  }

  // Channel-conditional credential require: a Slack run must not be blocked by a
  // missing Telegram token (and vice versa). Phase 0 only knows Telegram; the
  // factory throws for any other configured channel before we reach the loop.
  // Phase 4 adds: if (activeChannel === "slack" && (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN)) {…}
  if (activeChannel === "telegram" && !process.env.TELEGRAM_BOT_TOKEN) {
    process.stderr.write("poller: TELEGRAM_BOT_TOKEN must be set\n");
    process.exit(1);
  }
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  ensureReleaseFlagDir();
  cleanupStaleReleaseFlags();
  ensureInjectDir();
  // Both are Telegram-wire-specific (getMe / setMyCommands via the adapter, not
  // the transport contract). Guard on the active channel so a non-Telegram run
  // doesn't issue Telegram API calls. Phase 4 generalizes preflight onto
  // transport.whoami(); registerBotCommands moves behind isSlashCommandable once
  // TelegramTransport actually implements SlashCommandable.
  if (activeChannel === "telegram") {
    await preflightBotToken();
    await registerBotCommands();
  }
  let offset = readOffset();
  refreshMountsIfChanged();
  refreshPairedIfChanged();
  refreshSettingsIfChanged();
  initDaemonRegistry();
  startInjectWatcher();
  await processInjectFlags(); // drain anything dropped before this poller started
  // File-access (FDA) self-probe: we're in the launchd TCC context here, so this
  // is the only place that can truthfully report whether claude can reach
  // protected folders (Documents/Desktop/…). Result → $STATE_DIR/file-access.json
  // for cta status / Pager. Re-probed periodically in housekeep below.
  runFileAccessProbe(STATE_DIR);
  lastFileAccessProbe = Date.now();

  // H2: load persisted "fired today" state so a mid-day poller restart
  // can't cause a duplicate digest fire. Corrupt / missing file → empty
  // state (readHeartbeatState is defensive).
  heartbeatState = readHeartbeatState();

  const startupChat = effectiveChatId() ?? "(unpaired — awaiting /pair)";
  process.stdout.write(`[${new Date().toISOString()}] poller starting (Phase 4 daemon mode), offset=${offset}, chat=${startupChat}, mounts=${mountsCache.size}\n`);

  // ── Housekeeping off the poll cadence ──────────────────────────────────────
  // P3a: transport.start() below owns the inbound long-poll loop (it blocks on
  // getUpdates), so the periodic upkeep that used to ride each loop iteration
  // now runs on its own timer. A re-entrancy guard keeps a slow idle-sweep from
  // overlapping the next tick.
  let housekeeping = false;
  const housekeep = (): void => {
    if (housekeeping) return;
    housekeeping = true;
    void (async () => {
      try {
        // Wake-event interrupt (Pager touches WAKE_FLAG on
        // NSWorkspace.didWakeNotification). If observed, abort the in-flight
        // getUpdates so the next loop iteration dials a fresh socket — a
        // socket suspended through the sleep cycle would otherwise burn the
        // full ~40s long-poll budget before its own AbortController fires.
        // Single observation per flag write; unlink before signalling so a
        // racing housekeep tick doesn't double-fire.
        if (existsSync(WAKE_FLAG)) {
          try { unlinkSync(WAKE_FLAG); } catch { /* racing unlink — accept */ }
          if (isInterruptible(transport)) {
            transport.interruptInbound();
            process.stdout.write(`[${new Date().toISOString()}] wake-flag observed → forced inbound retry\n`);
          }
        }
        touchHeartbeat();
        refreshMountsIfChanged();
        refreshPairedIfChanged();
        refreshSettingsIfChanged();
        // Scheduled tasks — pure-logic shouldFireTask() per task, detached
        // gated agentic fire on fire=true. Never blocks the tick. run-now
        // flags from `cta task run` are consumed on the same cadence.
        refreshTasksIfChanged();
        taskDispatch();
        processTaskRunFlags();
        // Agentic approval cards — render pending requests the gate hook wrote,
        // reap expired ones. Detached sends; never blocks the tick.
        approvalDispatch();
        // Re-probe file access at most once a minute (FDA is granted rarely;
        // no need to readdir the canary every 5s tick).
        if (Date.now() - lastFileAccessProbe > 60_000) {
          lastFileAccessProbe = Date.now();
          runFileAccessProbe(STATE_DIR);
        }
        // Idle sweep (opt-in): for each topic quiet ≥ N min, decide by size.
        // Large transcript → flush durable memory then clear (rotate UUID →
        // fresh, cheap session); the flush runs DETACHED so a slow turn never
        // stalls this tick. Small transcript → evict only (resetTopic keeps the
        // UUID → next message --resumes, RAM reclaim, no context loss).
        // No-op unless the operator set a threshold.
        if (daemonRegistry && idleEvictMinutes > 0) {
          for (const threadIdStr of daemonRegistry.idleCandidates(idleEvictMinutes * 60_000)) {
            if (idleFlushing.has(threadIdStr)) continue;
            const key: number | "dm" = threadIdStr === "dm" ? "dm" : Number(threadIdStr);
            const mount = mountsCache.get(tgKey(key));
            const jsonl = mount ? jsonlPathForMount(mount) : null;
            let bytes = 0;
            if (jsonl) { try { bytes = statSync(jsonl).size; } catch { /* missing → 0 */ } }
            if (bytes > IDLE_CLEAR_MIN_BYTES) {
              void idleFlushAndClear(threadIdStr); // detached — must not block the tick
            } else {
              await daemonRegistry.resetTopic(threadIdStr);
              process.stdout.write(`[${new Date().toISOString()}] evicted idle daemon ${threadIdStr} after ${idleEvictMinutes}m (session ${bytes}B ≤ ${IDLE_CLEAR_MIN_BYTES}B)\n`);
            }
          }
        }
        // β handoff release/reacquire flags + watch-live inject. fs.watch
        // handles immediacy; this is the steady-state fallback drain.
        await processReleaseFlags();
        await processInjectFlags();
      } catch (e) {
        process.stderr.write(`poller: housekeeping tick failed: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        housekeeping = false;
      }
    })();
  };
  housekeep(); // once immediately — the old loop did upkeep before its first poll
  const housekeepTimer = setInterval(housekeep, 5_000);

  // ── Inbound: drive dispatch through the ChatTransport ──────────────────────
  // The poller routes on the normalized event KIND, not by probing raw Telegram
  // fields — so a second platform rides the same switch. Every kind dispatches to
  // a handler that consumes normalized fields; the only residual ev.raw reads are
  // the genuinely-Telegram-only edges: my_chat_member status transitions
  // (handleMyChatMember) and onButtonPress's callback_query id/prompt. The
  // transport owns the getUpdates loop + offset-before-dispatch durability.
  transport.onEvent(async (ev) => {
    switch (ev.kind) {
      case "transport-degraded":
        process.stderr.write(`poller: transport degraded: ${ev.reason}\n`);
        return;
      case "topic-created":
      case "topic-renamed":
        recordTopicNameFromEvent(ev);
        return;
      case "joined":
      case "removed": {
        const mcm = (ev.raw as TgUpdate).my_chat_member;
        if (mcm) await handleMyChatMember(mcm);
        return;
      }
      case "button-press":
        await onButtonPress(ev);
        return;
      case "message":
        await onInboundMessage(ev);
        return;
    }
  });
  await transport.start({});
  clearInterval(housekeepTimer); // unreachable in steady state (start() blocks)
}

// Tests import this module to drive command handlers directly. Only run the
// main loop when executed via `bun run …/poller.ts`, not on import.
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`poller: fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}

// Test surface: handlers + state-refresh exported so tests can drive the
// command pipeline without spinning up getUpdates. Keep export list narrow.
export {
  tryHandleCommand,
  handlePair,
  handleUnpair,
  handleMount,
  handleDm,
  handleUnmount,
  handleList,
  handleHelp,
  refreshPairedIfChanged,
  refreshMountsIfChanged,
  effectiveChatId,
  effectiveUserId,
  effortArg,
  type TgMessage,
  type InboundMessageEvent,
  type PairedState,
};
