/**
 * ChatTransport — the platform-agnostic chat interface for the Pager agent.
 *
 * Design: DI + small required core + optional capability interfaces (mautrix
 * bridgev2 pattern). One transport is constructed at `cta start` time, selected
 * by CTA_CHANNEL (default "telegram"). The poller feature-detects optional
 * capabilities (`if (isReactable(t)) …`) so a platform that lacks a feature
 * (e.g. LINE has no reactions) simply omits the interface instead of shipping
 * silent no-op landmines.
 *
 * STATUS: P2 (1/n) — the contract only. Nothing imports this yet; the poller
 * still calls the Telegram adapter directly. P2 (2/n) adds the TelegramTransport
 * implementation; P3 cuts the poller over to this interface.
 *
 * This module is platform-agnostic: it MUST NOT import any channels/<platform>/
 * code, so adding a platform never edits the core.
 */

export type Channel = "telegram" | "slack" | "discord" | "line";

/**
 * Platform-native address. Discriminated by `channel`; the poller passes it
 * opaquely. Each variant carries only the IDs that platform needs.
 *
 * Why not a single opaque string: mount-store and the bash mount CLI reason
 * about thread_id directly, so an opaque key would force the adapter to be
 * loaded on every mount read.
 */
export type ChatAddress =
  | { channel: "telegram"; chatId: number; threadId?: number } // threadId omitted = General topic / DM
  | { channel: "slack"; teamId: string; channelId: string; threadTs?: string }
  | { channel: "discord"; guildId: string | null; channelId: string }
  | { channel: "line"; targetKind: "user" | "group" | "room"; targetId: string };

/**
 * Opaque, transport-scoped message handle. Returned by every send and required
 * by edit/react/delete. Tagged union, not a bare string, so multi-id platforms
 * (Slack: channel+ts) don't encode/decode per call.
 *
 * Lesson from Hubot's v2→v3 regression: losing the sent-message return value
 * broke all downstream edit/react. Every send MUST return this.
 */
export type MessageRef =
  | { channel: "telegram"; chatId: number; messageId: number }
  | { channel: "slack"; channelId: string; ts: string }
  | { channel: "discord"; channelId: string; messageId: string }
  | { channel: "line" }; // LINE: no edit/delete/react — ref is informational only

/** Normalized sender. Allowlist auth runs against `id` (stable per scope). */
export interface SenderId {
  channel: Channel;
  id: string; // stringified (Telegram numeric, others not)
  displayName?: string; // mutable; UX only, NEVER auth
  isBot?: boolean;
}

/**
 * RoutingKey — the daemon-registry / mount key. THIS IS THE BARE thread-id
 * string in the current code ("dm" | "<thread_id>"), NOT "<channel>:<id>".
 * Kept that way so the daemon registry, the β release-flag filenames, and
 * /clear's resetTopic all keep working unchanged.
 *
 * The "<channel>:<id>" form ("telegram:42") is the mount-STORE cache key,
 * derived by the adapter via `mountCacheKey()`. Two distinct keys, on purpose:
 * registry is per-process-per-platform (bare id is enough); mount-store is
 * potentially multi-channel on disk (needs the prefix).
 */
export type RoutingKey = string & { readonly __brand: "RoutingKey" };

// ─── capabilities (graded, not boolean — bridgev2 RoomFeatures shape) ────────

/** Support level for a feature. Booleans can't say "edits allowed 15 min". */
export type Support = "rejected" | "dropped" | "unsupported" | "partial" | "full";

export interface Capabilities {
  inboundTransport: "long-poll" | "websocket" | "webhook-push";
  threadModel: "forum-topic" | "thread-ts" | "thread-channel" | "none";

  /** Two-stage ack delivery. "none" → poller skips the whole ack pipeline. */
  ackMechanism: "reaction-swap" | "reaction-stack" | "status-line" | "inline-text" | "none";

  text: { maxChars: number }; // adapter chunks above this
  edit: { support: Support; maxAgeSec?: number };
  reaction: {
    support: Support;
    maxPerBotPerMessage: number; // Telegram = 1 (drives swap-not-stack)
    allowedEmoji?: string[]; // Telegram free-bot whitelist (👌 ok, ✅ rejected)
    canStack: boolean; // Slack/Discord true; Telegram false
  };
  typing: { scope: "chat-thread" | "channel" | "dm-only" | "none"; keepaliveSec?: number };
  files: { in: Support; out: "multipart-bytes" | "three-step-upload" | "public-url-required" | "unsupported" };
  slashCommands: "registered" | "manifest" | "none"; // TG=registered, Slack=manifest, LINE=none

  /** Can the bot message a target it didn't just receive from? Critical for the
   *  secretary/heartbeat roadmap. A real per-platform constraint, NOT a safe
   *  assumption. */
  proactiveSend: Support;
}

// ─── inbound events — typed, no stringly bag ─────────────────────────────────

/** Opaque per-platform handles. Each adapter narrows these to its own shape. */
export type TypingToken = unknown;
export type AckHandle = unknown;
export type PlatformFileHandle = unknown;

/**
 * Normalized inbound event. Small universal core; the platform-native event is
 * carried in the TYPED-but-generic `raw` field (defaults to `unknown` so the
 * core stays platform-agnostic — the adapter emits `InboundEvent<TgUpdate>` and
 * consumers narrow via the `channel`/`address.channel` discriminant). This is
 * the type-safe opposite of matterbridge's untyped map[string]interface{} bag.
 *
 * NOTE: no reaction-added/removed — the bot does not subscribe to inbound
 * reactions (allowed_updates omits message_reaction).
 */
export type InboundEvent<Raw = unknown> =
  | {
      kind: "message";
      routingKey: RoutingKey;
      address: ChatAddress;
      from: SenderId;
      text: string;
      messageRef: MessageRef;
      files?: PlatformFileHandle[];
      raw: Raw;
    }
  | {
      kind: "button-press";
      routingKey: RoutingKey;
      address: ChatAddress;
      from: SenderId;
      label: string;
      messageRef: MessageRef;
      raw: Raw;
    }
  | { kind: "topic-created"; routingKey: RoutingKey; name: string; raw: Raw }
  | { kind: "topic-renamed"; routingKey: RoutingKey; name: string; raw: Raw }
  | { kind: "joined"; address: ChatAddress; invitedBy?: SenderId; chatTitle?: string; needsAdminForText?: boolean; raw: Raw }
  | { kind: "removed"; address: ChatAddress; raw: Raw }
  // Successful inbound read (including an empty long-poll). The poller uses
  // this to heartbeat actual transport progress instead of a blind timer.
  | { kind: "transport-progress" }
  // reconnecting; informational. Fatal errors → adapter throws from start()/run
  // loop → process.exit → launchd respawn.
  | { kind: "transport-degraded"; reason: string };

// ─── delivery boundaries ────────────────────────────────────────────────────

/**
 * Durable hand-off used by pull transports before they advance a remote
 * cursor. `persist` is synchronous and must either make the entry recoverable
 * or throw. `listPending` returns recovery order; `remove` is idempotent and
 * best-effort after dispatch.
 *
 * This deliberately does not promise exactly-once delivery. A crash may replay
 * an entry whose side effects completed before `remove`.
 */
export interface InboundJournal<Entry, Id = string> {
  persist(entry: Entry): void;
  listPending(): Entry[];
  remove(id: Id): void;
}

/** User-visible chat output. Reactions, typing and command registration remain
 * transport capabilities rather than queued messages. */
export type OutboundButton = string | { label: string; action: string };

export type OutboundMessage =
  | { kind: "text"; to: ChatAddress; text: string; deliveryKey?: string }
  | { kind: "buttons"; to: ChatAddress; text: string; buttons: OutboundButton[]; deliveryKey?: string };

/**
 * Ordering seam for user-visible chat output. The Phase 0 implementation is an
 * immediate pass-through: resolution means the transport's send attempt has
 * finished. It does NOT yet promise persistence, retry, deduplication,
 * backpressure or confirmed platform delivery.
 */
export interface OutboundQueue {
  enqueue(message: OutboundMessage): Promise<void>;
  enqueueTracked(message: OutboundMessage): Promise<OutboundQueueResult>;
  /** Durable records which are not yet in a confirmed terminal state. */
  depth(): number;
  /** Stop retry polling and wait for an in-flight drain. */
  stop(): Promise<void>;
}

export interface OutboundQueueResult {
  status: "queued" | "delivered" | "retry_scheduled" | "dead_letter" | "uncertain";
  messageRef?: MessageRef;
}

/** A handler may defer its durable acknowledgement until downstream work has
 * actually finished. The transport keeps the inbound journal at dispatched
 * until completion settles, so a process death cannot silently turn an
 * in-memory handoff into completed delivery. */
export interface DeferredInboundCompletion {
  completion: Promise<void>;
}

export type InboundHandlerResult = void | DeferredInboundCompletion;

// ─── core interface (required) ───────────────────────────────────────────────

/** REQUIRED. Every adapter implements exactly this. */
export interface ChatTransport {
  readonly channel: Channel;
  readonly transportVersion: number;
  readonly capabilities: Capabilities;

  /** Open inbound (long-poll / WS / webhook server). publicUrl required iff
   *  capabilities.inboundTransport === "webhook-push" (LINE). Resolves when
   *  ready; throws fatally on bad credentials (poller exits, launchd respawns). */
  start(opts: { publicUrl?: string }): Promise<void>;
  stop(): Promise<void>; // graceful, <5s (SIGTERM budget)

  /** Subscribe to normalized inbound events. Adapter owns reconnect; emits
   *  `transport-degraded` while retrying and `transport-progress` after a
   *  successful read. Before advancing its remote cursor, the adapter MUST
   *  durably persist inbound work so a crash cannot silently drop it. */
  onEvent(handler: (e: InboundEvent) => Promise<InboundHandlerResult>): void;

  whoami(): Promise<{ id: string; username?: string; displayName?: string }>;

  /** Send plain text. Returns ref for later edit/react. Chunks above
   *  capabilities.text.maxChars and returns the LAST chunk's ref. The poller's
   *  primary outbound path (maps to reply(), NOT MCP). */
  sendText(args: { to: ChatAddress; text: string }): Promise<MessageRef>;

  /** Encode the mount-STORE cache key ("telegram:42"). The RoutingKey (bare
   *  "42") is computed by `routingKey`; this is the prefixed disk-lookup key. */
  mountCacheKey(address: ChatAddress): string;
  routingKey(address: ChatAddress): RoutingKey;
}

// ─── optional capability interfaces (implemented only where supported) ───────

export interface Editable {
  editText(ref: MessageRef, text: string): Promise<void>;
}

export interface Reactable {
  /** Register the "delivered" ack on an inbound message. The poller calls this
   *  at dispatch. Returns a handle to later flip, or null if the adapter
   *  declines (e.g. operator disabled the glyph). The glyph is chosen by the
   *  adapter from capabilities/operator-config. */
  setDeliveredAck(target: MessageRef): Promise<AckHandle | null>;
  /** Flip delivered→read. May be called with MANY handles at once (N:1 flush
   *  fan-in). On swap platforms this replaces the glyph; on stack platforms it
   *  adds. */
  setReadAcks(handles: AckHandle[]): Promise<void>;
}

export interface TypingIndicating {
  startTyping(to: ChatAddress): Promise<TypingToken>;
  stopTyping(token: TypingToken): Promise<void>;
  /** Cross-process clear (a different process — e.g. the buttons sender —
   *  clears typing after a send). Implemented via the on-disk typing marker. */
  clearTypingExternal(address: ChatAddress): Promise<void>;
}

export interface FileCapable {
  downloadFile(handle: PlatformFileHandle): Promise<{ bytes: Uint8Array; mime: string; filename?: string }>;
  sendFile(args: {
    to: ChatAddress;
    bytes: Uint8Array;
    mime: string;
    filename?: string;
    caption?: string;
  }): Promise<MessageRef>;
}

export interface SlashCommandable {
  registerCommands(cmds: Array<{ name: string; description: string }>): Promise<void>;
}

export interface ButtonCapable {
  /** Inline-keyboard choice buttons. On Telegram this is the MCP send_telegram
   *  path (separate process); on Slack/Discord native components; on LINE a
   *  Quick Reply. Each tap returns a `button-press` InboundEvent. */
  sendButtons(args: { to: ChatAddress; text: string; buttons: OutboundButton[] }): Promise<MessageRef>;
}

export interface ProactiveCapable {
  /** Message a target without a triggering inbound message (heartbeat /
   *  secretary notifications). Separate interface because some platforms simply
   *  can't do this. */
  sendProactive(args: { to: ChatAddress; text: string }): Promise<MessageRef>;
}

export interface InboundInterruptible {
  /** Force the current inbound read in flight to abort and the loop to retry
   *  immediately with a fresh socket. Wired to a host wake-event (macOS
   *  NSWorkspace.didWakeNotification surfaced via a flag file the poller
   *  observes in housekeep): a stale long-poll socket that survived a sleep
   *  cycle would otherwise burn the full timeoutSec+slack before the abort
   *  fires. Idempotent — multiple calls collapse to one abort.
   *  Transports without a controllable abort (e.g. webhook-push) may skip
   *  implementing this; the housekeep guard feature-detects via
   *  isInterruptible(). */
  interruptInbound(): void;
}

// ─── type guards (poller feature-detects on capability, never on `channel`) ──

export const isEditable = (t: ChatTransport): t is ChatTransport & Editable => "editText" in t;
export const isReactable = (t: ChatTransport): t is ChatTransport & Reactable => "setDeliveredAck" in t;
export const isTyping = (t: ChatTransport): t is ChatTransport & TypingIndicating => "startTyping" in t;
export const isInterruptible = (t: ChatTransport): t is ChatTransport & InboundInterruptible => "interruptInbound" in t;
export const isFileCapable = (t: ChatTransport): t is ChatTransport & FileCapable => "sendFile" in t;
export const isSlashCommandable = (t: ChatTransport): t is ChatTransport & SlashCommandable =>
  "registerCommands" in t;
export const isButtonCapable = (t: ChatTransport): t is ChatTransport & ButtonCapable => "sendButtons" in t;
export const isProactive = (t: ChatTransport): t is ChatTransport & ProactiveCapable => "sendProactive" in t;
