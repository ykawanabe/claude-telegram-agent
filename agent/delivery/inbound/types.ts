/**
 * Durable inbound delivery states.
 *
 * `dispatched` is the point-of-no-return: it must be persisted immediately
 * before invoking code that may produce an externally visible side effect.
 * A process death after that write can no longer prove whether the effect
 * happened, so recovery quarantines the record as `uncertain` rather than
 * risking an automatic duplicate.
 */
export type InboundDeliveryState =
  | "received"
  | "claimed"
  | "dispatched"
  | "completed"
  | "uncertain";

/** The three failure classes callers and operators must not conflate. */
export type InboundFailureSemantic = "loss" | "duplicate" | "outcome-unknown";

/**
 * Shadow records the decision but never blocks the legacy path. Enforced makes
 * the journal's process/suppress/hold decision authoritative.
 */
export type InboundJournalMode = "shadow" | "enforced";

export interface InboundEnvelope<Payload> {
  /** Stable upstream identity (Telegram update_id, webhook event id, ...). */
  messageId: string;
  payload: Payload;
  /** Optional source timestamp. The journal always adds its own receivedAt. */
  sourceTimestamp?: string;
}

export interface InboundFailure {
  semantic: Exclude<InboundFailureSemantic, "duplicate">;
  reason: string;
  at: string;
}

export interface InboundTransition {
  from: InboundDeliveryState | null;
  to: InboundDeliveryState;
  at: string;
  reason?: string;
  owner?: string;
}

export interface InboundClaim {
  owner: string;
  token: string;
  claimedAt: string;
  leaseUntil: string;
}

export interface DuplicateObservations {
  count: number;
  lastSeenAt?: string;
  /** Duplicates shadow mode allowed through but enforced mode would suppress. */
  shadowWouldSuppress: number;
  /** Unknown outcomes shadow mode allowed through but enforced would hold. */
  shadowWouldHold: number;
}

export interface InboundJournalRecord<Payload> {
  version: 1;
  messageId: string;
  state: InboundDeliveryState;
  payload: Payload;
  sourceTimestamp?: string;
  receivedAt: string;
  updatedAt: string;
  attempt: number;
  claim?: InboundClaim;
  dispatchedAt?: string;
  completedAt?: string;
  uncertainAt?: string;
  failure?: InboundFailure;
  duplicates: DuplicateObservations;
  history: InboundTransition[];
}

export type InboundAdmissionClassification =
  | "new"
  | "duplicate"
  | "loss"
  | "outcome-unknown"
  | "journal-error";

export type InboundAdmissionAction = "process" | "suppress" | "hold" | "fail-closed";

export interface InboundAdmission<Payload> {
  mode: InboundJournalMode;
  classification: InboundAdmissionClassification;
  /** What the caller should do in the current mode. */
  action: Exclude<InboundAdmissionAction, "fail-closed">;
  /** Decision enforced mode would make; used to compare shadow behaviour. */
  wouldEnforce: InboundAdmissionAction;
  /** False means no lifecycle transitions may be made for this observation. */
  managed: boolean;
  journaled: boolean;
  failureSemantic?: InboundFailureSemantic;
  record?: InboundJournalRecord<Payload>;
  error?: string;
}

export interface ReplayEntry<Payload> {
  messageId: string;
  payload: Payload;
  sourceTimestamp?: string;
  receivedAt: string;
  attempt: number;
}

export interface JournalIssue {
  semantic: "loss";
  reason: "corrupt-record" | "message-id-mismatch" | "unreadable-record";
  path: string;
  detectedAt: string;
  messageId?: string;
  detail: string;
  quarantinePath?: string;
}

export interface RecoveryResult<Payload> {
  replayable: ReplayEntry<Payload>[];
  uncertain: Array<InboundJournalRecord<Payload>>;
  losses: JournalIssue[];
  recoveredClaims: number;
  newlyUncertain: number;
}

export interface InboundJournalSummary {
  mode: InboundJournalMode;
  states: Record<InboundDeliveryState, number>;
  duplicateObservations: number;
  shadowWouldSuppress: number;
  shadowWouldHold: number;
  knownLosses: number;
  unknownOutcomes: number;
  corruptRecords: number;
}

export type JournalWritePoint =
  | "before-temp-write"
  | "after-temp-fsync"
  | "before-rename"
  | "after-rename"
  | "after-directory-fsync";

/** Public fault seam shared by unit/fault tests and the reliability harness. */
export interface InboundJournalFaultInjector {
  onWrite?(point: JournalWritePoint, destination: string): void;
}

export class InboundDeliveryError extends Error {
  constructor(
    message: string,
    readonly semantic: Exclude<InboundFailureSemantic, "duplicate">,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "InboundDeliveryError";
  }
}
