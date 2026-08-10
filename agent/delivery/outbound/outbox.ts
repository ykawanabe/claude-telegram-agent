import type { OutboundMessage } from "../../channels/types";
import { FileOutboxStore } from "./store";
import {
  OUTBOX_SCHEMA_VERSION,
  OutboundSendError,
  type DeliveryResult,
  type OutboundFailure,
  type OutboundSender,
  type OutboxEvent,
  type OutboxEventSink,
  type OutboxMode,
  type OutboxRecord,
  type OutboxState,
} from "./types";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface PersistentOutboxOptions {
  store: FileOutboxStore;
  sender: OutboundSender;
  mode?: OutboxMode;
  retry?: Partial<RetryPolicy>;
  now?: () => number;
  random?: () => number;
  events?: OutboxEventSink;
  pollIntervalMs?: number;
}

export interface EnqueueOptions {
  /** Stable application-level ID. Reusing it returns the prior result. */
  id?: string;
  /** Convenience dedupe key, hashed before it is used as a filename. */
  deduplicationKey?: string;
  /** Persist only. Useful when a separate dispatcher owns sending. */
  dispatchNow?: boolean;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};

/** Durable, single-consumer outbound queue. */
export class PersistentOutbox {
  readonly mode: OutboxMode;
  private readonly store: FileOutboxStore;
  private readonly sender: OutboundSender;
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly events?: OutboxEventSink;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<DeliveryResult[]> | null = null;

  constructor(options: PersistentOutboxOptions) {
    this.store = options.store;
    this.sender = options.sender;
    this.mode = options.mode ?? "shadow";
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    if (!Number.isSafeInteger(this.retry.maxAttempts) || this.retry.maxAttempts < 1) {
      throw new Error("outbox maxAttempts must be a positive integer");
    }
    if (!(this.retry.baseDelayMs > 0) || this.retry.maxDelayMs < this.retry.baseDelayMs) {
      throw new Error("outbox retry delays are invalid");
    }
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.events = options.events;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  /** Persist before the first network call, then attempt immediately by default. */
  async enqueue(message: OutboundMessage, options: EnqueueOptions = {}): Promise<DeliveryResult> {
    if (options.id && options.deduplicationKey) {
      throw new Error("specify either id or deduplicationKey, not both");
    }
    const id = options.id
      ?? (options.deduplicationKey
        ? FileOutboxStore.idForDeduplicationKey(options.deduplicationKey)
        : this.store.createId());
    const existing = this.store.get(id);
    if (existing) return { ...this.resultOf(existing), deduplicated: true };

    const at = this.now();
    const record: OutboxRecord = {
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      id,
      deduplicationKey: options.deduplicationKey,
      mode: this.mode,
      message,
      state: "queued",
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    // A persistence error rejects before sender.send: disk-full cannot degrade
    // into an unjournaled network side effect.
    this.store.save(record);
    this.emit("outbox.enqueued", record);
    if (options.dispatchNow === false) return this.resultOf(record);
    return this.attempt(record);
  }

  /**
   * Recover a process that died after marking a request `sending`. Telegram has
   * no sendMessage idempotency key, so those records become `uncertain` instead
   * of being blindly replayed.
   */
  recoverInFlight(): OutboxRecord[] {
    const recovered: OutboxRecord[] = [];
    for (const record of this.store.listPending()) {
      if (record.state !== "sending") continue;
      const failure: OutboundFailure = {
        kind: "uncertain",
        message: "process stopped while the remote send result was not durable",
        at: this.now(),
        retryable: false,
      };
      const next = this.transition(record, "uncertain", { failure, nextAttemptAt: undefined });
      this.store.save(next);
      this.emit("outbox.recovered_in_flight", next);
      recovered.push(next);
    }
    return recovered;
  }

  /** Send every due queued/retry record once, in stable recovery order. */
  async drainDue(): Promise<DeliveryResult[]> {
    if (this.draining) return this.draining;
    this.draining = this.doDrainDue();
    try {
      return await this.draining;
    } finally {
      this.draining = null;
    }
  }

  start(): void {
    if (this.timer) return;
    this.recoverInFlight();
    void this.drainDue();
    this.timer = setInterval(() => { void this.drainDue(); }, this.pollIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.draining) await this.draining;
  }

  /** Current durable backlog, including retry-wait and uncertain records. */
  depth(): number {
    return this.store.listPending().length;
  }

  private async doDrainDue(): Promise<DeliveryResult[]> {
    if (this.mode === "shadow") return [];
    const now = this.now();
    const results: DeliveryResult[] = [];
    for (const record of this.store.listPending()) {
      if (record.state === "uncertain" || record.state === "sending") continue;
      if (record.state === "retry_wait" && (record.nextAttemptAt ?? Infinity) > now) continue;
      results.push(await this.attempt(record));
    }
    return results;
  }

  private async attempt(record: OutboxRecord): Promise<DeliveryResult> {
    const current = this.store.get(record.id);
    if (!current) throw new Error(`outbox record disappeared: ${record.id}`);
    if (["delivered", "dead_letter", "uncertain"].includes(current.state)) return this.resultOf(current);
    // Another drain/enqueue call already owns the network attempt. A process
    // restart handles a genuinely abandoned `sending` record via
    // recoverInFlight(); a live concurrent caller must never double-send it.
    if (current.state === "sending") return this.resultOf(current);
    if (current.state === "retry_wait" && (current.nextAttemptAt ?? Infinity) > this.now()) {
      return this.resultOf(current);
    }

    const sending = this.transition(current, "sending", {
      attempts: current.attempts + 1,
      failure: undefined,
      nextAttemptAt: undefined,
      shadowComparison: undefined,
    });
    this.store.save(sending);
    this.emit("outbox.attempt_started", sending);

    try {
      const messageRef = await this.sender.send(sending.message);
      const delivered = this.transition(sending, "delivered", { result: messageRef });
      this.store.save(delivered);
      this.emit("outbox.delivered", delivered);
      return this.resultOf(delivered);
    } catch (error) {
      return this.handleFailure(sending, error);
    }
  }

  private handleFailure(record: OutboxRecord, error: unknown): DeliveryResult {
    const typed = error instanceof OutboundSendError
      ? error
      : new OutboundSendError({
        kind: "uncertain",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    const at = this.now();
    const failure: OutboundFailure = {
      kind: typed.kind,
      message: typed.message,
      at,
      retryable: typed.retryable,
      retryAfterMs: typed.retryAfterMs,
      httpStatus: typed.httpStatus,
      telegramErrorCode: typed.telegramErrorCode,
    };

    const enforcedState: "retry_wait" | "dead_letter" | "uncertain" =
      typed.kind === "uncertain"
        ? "uncertain"
        : typed.retryable && record.attempts < this.retry.maxAttempts
          ? "retry_wait"
          : "dead_letter";
    const retryAt = enforcedState === "retry_wait"
      ? at + this.retryDelayMs(record.attempts, typed.retryAfterMs)
      : undefined;

    if (this.mode === "shadow") {
      // Shadow observes one real, immediate attempt but never changes retry
      // behaviour. The enforced decision is retained for rollout comparison.
      const shadowState = enforcedState === "uncertain" ? "uncertain" : "dead_letter";
      const shadow = this.transition(record, shadowState, {
        failure,
        shadowComparison: { wouldTransitionTo: enforcedState, nextAttemptAt: retryAt },
      });
      this.store.save(shadow);
      this.emit("outbox.shadow_compared", shadow);
      this.emit(shadowState === "uncertain" ? "outbox.uncertain" : "outbox.dead_lettered", shadow);
      return this.resultOf(shadow);
    }

    const next = this.transition(record, enforcedState, { failure, nextAttemptAt: retryAt });
    this.store.save(next);
    this.emit(
      enforcedState === "retry_wait"
        ? "outbox.retry_scheduled"
        : enforcedState === "uncertain"
          ? "outbox.uncertain"
          : "outbox.dead_lettered",
      next,
    );
    return this.resultOf(next);
  }

  /** Equal-jitter exponential backoff: [cap/2, cap], bounded by maxDelayMs. */
  private retryDelayMs(attempts: number, retryAfterMs?: number): number {
    const cap = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * (2 ** Math.max(0, attempts - 1)));
    const random = Math.min(1, Math.max(0, this.random()));
    const jittered = Math.floor((cap / 2) + (random * cap / 2));
    // retry_after is a server-declared minimum; jitter must never violate it.
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  private transition(
    record: OutboxRecord,
    state: OutboxState,
    patch: Partial<OutboxRecord>,
  ): OutboxRecord {
    return { ...record, ...patch, state, updatedAt: this.now() };
  }

  private resultOf(record: OutboxRecord): DeliveryResult {
    const status: DeliveryResult["status"] =
      record.state === "delivered" ? "delivered"
        : record.state === "retry_wait" ? "retry_scheduled"
          : record.state === "dead_letter" ? "dead_letter"
            : record.state === "uncertain" || record.state === "sending" ? "uncertain"
              : "queued";
    return {
      outboxId: record.id,
      status,
      attempts: record.attempts,
      messageRef: record.result,
      nextAttemptAt: record.nextAttemptAt,
      failure: record.failure,
      shadowComparison: record.shadowComparison,
    };
  }

  private emit(name: OutboxEvent["name"], record: OutboxRecord): void {
    if (!this.events) return;
    const event: OutboxEvent = {
      name,
      at: this.now(),
      outboxId: record.id,
      mode: record.mode,
      attempt: record.attempts,
      state: record.state,
      failureKind: record.failure?.kind,
      httpStatus: record.failure?.httpStatus,
      retryAfterMs: record.failure?.retryAfterMs,
      nextAttemptAt: record.nextAttemptAt,
      messageRef: record.result,
    };
    try { this.events(event); } catch { /* telemetry must not alter delivery */ }
  }
}
