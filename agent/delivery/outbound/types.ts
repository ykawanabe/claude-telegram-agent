import type { MessageRef, OutboundMessage } from "../../channels/types";

export const OUTBOX_SCHEMA_VERSION = 1 as const;

export type OutboxMode = "shadow" | "enforced";

export type OutboxState =
  | "queued"
  | "sending"
  | "retry_wait"
  | "delivered"
  | "dead_letter"
  | "uncertain";

export type OutboundFailureKind =
  | "rate_limited"
  | "server_error"
  | "permanent"
  | "uncertain";

export interface OutboundFailure {
  kind: OutboundFailureKind;
  message: string;
  at: number;
  retryable: boolean;
  retryAfterMs?: number;
  httpStatus?: number;
  telegramErrorCode?: number;
}

export interface ShadowComparison {
  /** The state the enforced policy would have selected after this attempt. */
  wouldTransitionTo: "retry_wait" | "dead_letter" | "uncertain";
  nextAttemptAt?: number;
}

export interface OutboxRecord {
  schemaVersion: typeof OUTBOX_SCHEMA_VERSION;
  id: string;
  deduplicationKey?: string;
  mode: OutboxMode;
  message: OutboundMessage;
  state: OutboxState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  result?: MessageRef;
  failure?: OutboundFailure;
  shadowComparison?: ShadowComparison;
}

export type DeliveryStatus =
  | "queued"
  | "delivered"
  | "retry_scheduled"
  | "dead_letter"
  | "uncertain";

export interface DeliveryResult {
  outboxId: string;
  status: DeliveryStatus;
  attempts: number;
  /** The platform's real result, including Telegram's non-zero message_id. */
  messageRef?: MessageRef;
  nextAttemptAt?: number;
  failure?: OutboundFailure;
  shadowComparison?: ShadowComparison;
  deduplicated?: boolean;
}

export interface OutboundSender {
  send(message: OutboundMessage): Promise<MessageRef>;
}

export interface OutboxEvent {
  name:
    | "outbox.enqueued"
    | "outbox.attempt_started"
    | "outbox.delivered"
    | "outbox.retry_scheduled"
    | "outbox.dead_lettered"
    | "outbox.uncertain"
    | "outbox.shadow_compared"
    | "outbox.recovered_in_flight";
  at: number;
  outboxId: string;
  mode: OutboxMode;
  attempt: number;
  state: OutboxState;
  failureKind?: OutboundFailureKind;
  httpStatus?: number;
  retryAfterMs?: number;
  nextAttemptAt?: number;
  messageRef?: MessageRef;
}

export type OutboxEventSink = (event: OutboxEvent) => void;

/** Default-safe rollout switch: absent configuration always means shadow. */
export function outboxModeFromEnv(
  value = process.env.CTA_OUTBOX_MODE,
): OutboxMode {
  if (value == null || value.trim() === "" || value === "shadow") return "shadow";
  if (value === "enforced") return "enforced";
  throw new Error(`CTA_OUTBOX_MODE must be shadow or enforced (got ${JSON.stringify(value)})`);
}

/**
 * A typed failure from a platform sender. Only failures explicitly marked
 * retryable are automatically replayed. Unknown exceptions become
 * `uncertain`, because the remote side may have accepted the request.
 */
export class OutboundSendError extends Error {
  readonly kind: OutboundFailureKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly telegramErrorCode?: number;

  constructor(args: {
    kind: OutboundFailureKind;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    httpStatus?: number;
    telegramErrorCode?: number;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "OutboundSendError";
    this.kind = args.kind;
    this.retryable = args.retryable ?? false;
    this.retryAfterMs = args.retryAfterMs;
    this.httpStatus = args.httpStatus;
    this.telegramErrorCode = args.telegramErrorCode;
  }
}
