import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type {
  DuplicateObservations,
  InboundAdmission,
  InboundEnvelope,
  InboundJournalFaultInjector,
  InboundJournalMode,
  InboundJournalRecord,
  InboundJournalSummary,
  InboundDeliveryState,
  JournalIssue,
  RecoveryResult,
  ReplayEntry,
} from "./types";
import { InboundDeliveryError } from "./types";

interface StoredRecord<Payload> {
  format: "pager-inbound-journal";
  formatVersion: 1;
  record: InboundJournalRecord<Payload>;
  checksum: string;
}

export interface FileInboundJournalOptions {
  rootDir: string;
  mode?: InboundJournalMode;
  now?: () => Date;
  makeToken?: () => string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  faultInjector?: InboundJournalFaultInjector;
}

const RECORD_SUFFIX = ".json";
const MAX_HISTORY = 128;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

/** Default-safe rollout switch: absent configuration always means shadow. */
export function inboundJournalModeFromEnv(
  value = process.env.CTA_INBOUND_JOURNAL_MODE,
): InboundJournalMode {
  if (value == null || value.trim() === "" || value === "shadow") return "shadow";
  if (value === "enforced") return "enforced";
  throw new Error(`CTA_INBOUND_JOURNAL_MODE must be shadow or enforced (got ${JSON.stringify(value)})`);
}

/**
 * Crash-safe, filesystem-backed inbound journal.
 *
 * The directory is intentionally transport-neutral. One record per stable
 * message ID is written with tempfile + fsync + atomic rename + directory
 * fsync. A process-wide directory lock serializes dedupe and transitions;
 * stale locks from dead processes are recoverable.
 */
export class FileInboundJournal<Payload> {
  private readonly recordsDir: string;
  private readonly quarantineDir: string;
  private readonly lockDir: string;
  private currentMode: InboundJournalMode;
  private readonly now: () => Date;
  private readonly makeToken: () => string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly faultInjector?: InboundJournalFaultInjector;

  constructor(private readonly options: FileInboundJournalOptions) {
    this.recordsDir = join(options.rootDir, "records");
    this.quarantineDir = join(options.rootDir, "quarantine");
    this.lockDir = join(options.rootDir, ".journal.lock");
    this.currentMode = options.mode ?? "shadow";
    this.now = options.now ?? (() => new Date());
    this.makeToken = options.makeToken ?? randomUUID;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    if (this.lockTimeoutMs < 0 || this.staleLockMs <= 0) {
      throw new Error("lockTimeoutMs must be >= 0 and staleLockMs must be > 0");
    }
    this.faultInjector = options.faultInjector;
  }

  get mode(): InboundJournalMode {
    return this.currentMode;
  }

  /** Supports a live shadow → enforced cutover without changing disk format. */
  setMode(mode: InboundJournalMode): void {
    this.currentMode = mode;
  }

  /**
   * Persist and classify one upstream message.
   *
   * In shadow mode journal I/O errors are returned as an observable `loss`
   * classification while the legacy path is allowed to continue. Enforced
   * mode fails closed because advancing the upstream cursor would lose work.
   */
  receive(envelope: InboundEnvelope<Payload>): InboundAdmission<Payload> {
    try {
      return this.withLock(() => this.admitLocked(envelope));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      if (this.currentMode === "shadow") {
        return {
          mode: this.currentMode,
          classification: "journal-error",
          action: "process",
          wouldEnforce: "fail-closed",
          managed: false,
          journaled: false,
          failureSemantic: "loss",
          error,
        };
      }
      if (cause instanceof InboundDeliveryError) throw cause;
      throw new InboundDeliveryError(`inbound journal admission failed: ${error}`, "loss", cause);
    }
  }

  /** Backward-compatible descriptive alias; integrations should prefer receive. */
  admit(envelope: InboundEnvelope<Payload>): InboundAdmission<Payload> {
    return this.receive(envelope);
  }

  claim(messageId: string, owner: string, leaseMs = 60_000): InboundJournalRecord<Payload> {
    if (!owner.trim()) throw new Error("claim owner must not be empty");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("claim leaseMs must be > 0");
    return this.withLock(() => {
      let record = this.requireRecordLocked(messageId);
      if (record.state === "claimed" && Date.parse(record.claim?.leaseUntil ?? "") <= this.now().getTime()) {
        record = this.transition(record, "received", "expired-claim-released");
      }
      this.requireState(record, ["received"], "claim");
      const at = this.timestamp();
      const claim = {
        owner,
        token: this.makeToken(),
        claimedAt: at,
        leaseUntil: new Date(this.now().getTime() + leaseMs).toISOString(),
      };
      record = this.transition(record, "claimed", undefined, owner);
      record.claim = claim;
      record.attempt += 1;
      this.writeRecord(record);
      return clone(record);
    });
  }

  /** Return a not-yet-dispatched claim to the replay queue. */
  releaseClaim(messageId: string, claimToken: string, reason = "claim-released"): InboundJournalRecord<Payload> {
    return this.withLock(() => {
      let record = this.requireClaimLocked(messageId, claimToken, ["claimed"]);
      record = this.transition(record, "received", reason);
      delete record.claim;
      this.writeRecord(record);
      return clone(record);
    });
  }

  /** Persist immediately before invoking code that can cause side effects. */
  markDispatched(messageId: string, claimToken: string): InboundJournalRecord<Payload> {
    return this.withLock(() => {
      let record = this.requireClaimLocked(messageId, claimToken, ["claimed"]);
      const at = this.timestamp();
      record = this.transition(record, "dispatched");
      record.dispatchedAt = at;
      this.writeRecord(record);
      return clone(record);
    });
  }

  /** A positive handler acknowledgement is the only route to completed. */
  complete(messageId: string, claimToken: string): InboundJournalRecord<Payload> {
    return this.withLock(() => {
      let record = this.requireClaimLocked(messageId, claimToken, ["dispatched"]);
      const at = this.timestamp();
      record = this.transition(record, "completed");
      record.completedAt = at;
      delete record.claim;
      this.writeRecord(record);
      return clone(record);
    });
  }

  /**
   * Use after dispatch began but its result cannot be proven. This is terminal
   * until an operator explicitly resolves it; automatic replay is unsafe.
   */
  markOutcomeUnknown(messageId: string, claimToken: string, reason: string): InboundJournalRecord<Payload> {
    return this.withLock(() => {
      let record = this.requireClaimLocked(messageId, claimToken, ["dispatched"]);
      record = this.toUncertain(record, "outcome-unknown", reason);
      this.writeRecord(record);
      return clone(record);
    });
  }

  /** Concise alias matching the terminal state name. */
  uncertain(messageId: string, claimToken: string, reason: string): InboundJournalRecord<Payload> {
    return this.markOutcomeUnknown(messageId, claimToken, reason);
  }

  /** Mark known pre-dispatch abandonment/corruption distinctly from unknown outcome. */
  markLost(messageId: string, claimToken: string, reason: string): InboundJournalRecord<Payload> {
    return this.withLock(() => {
      let record = this.requireClaimLocked(messageId, claimToken, ["claimed"]);
      record = this.toUncertain(record, "loss", reason);
      this.writeRecord(record);
      return clone(record);
    });
  }

  /**
   * Singleton-startup recovery. Claimed work is safe to replay because the
   * side-effect boundary was never crossed. Dispatched work is quarantined as
   * outcome-unknown. The operation is idempotent across repeated crashes.
   */
  recoverAfterCrash(): RecoveryResult<Payload> {
    return this.withLock(() => {
      const replayable: ReplayEntry<Payload>[] = [];
      const uncertain: Array<InboundJournalRecord<Payload>> = [];
      // Previously quarantined corruption stays observable after every restart;
      // it must not disappear merely because the bad record was already moved.
      const losses: JournalIssue[] = this.listIssuesLocked();
      let recoveredClaims = 0;
      let newlyUncertain = 0;

      for (const path of this.recordPaths()) {
        let record: InboundJournalRecord<Payload>;
        try {
          record = this.readRecordPath(path);
        } catch (cause) {
          losses.push(this.quarantineCorruptLocked(path, cause));
          continue;
        }
        if (record.state === "claimed") {
          record = this.transition(record, "received", "crash-recovered-claim");
          delete record.claim;
          this.writeRecord(record);
          recoveredClaims += 1;
        } else if (record.state === "dispatched") {
          record = this.toUncertain(
            record,
            "outcome-unknown",
            "process exited after dispatch began and before completion was persisted",
          );
          this.writeRecord(record);
          newlyUncertain += 1;
        }
        if (record.state === "received") replayable.push(replayOf(record));
        if (record.state === "uncertain") uncertain.push(clone(record));
      }
      replayable.sort(replayOrder);
      uncertain.sort(recordOrder);
      return { replayable, uncertain, losses, recoveredClaims, newlyUncertain };
    });
  }

  /** Read-only replay queue; callers normally invoke recoverAfterCrash first. */
  listReplayable(): ReplayEntry<Payload>[] {
    return this.withLock(() => {
      const entries: ReplayEntry<Payload>[] = [];
      for (const path of this.recordPaths()) {
        const record = this.readRecordPath(path);
        if (record.state === "received") entries.push(replayOf(record));
      }
      return entries.sort(replayOrder);
    });
  }

  get(messageId: string): InboundJournalRecord<Payload> | undefined {
    return this.withLock(() => {
      const path = this.recordPath(messageId);
      if (!existsSync(path)) return undefined;
      const record = this.readRecordPath(path);
      if (record.messageId !== messageId) {
        throw new InboundDeliveryError(`record message ID mismatch for ${messageId}`, "loss");
      }
      return clone(record);
    });
  }

  /** Durable integrity losses, including ones found by an earlier process. */
  listIssues(): JournalIssue[] {
    return this.withLock(() => this.listIssuesLocked());
  }

  /** Persistent rollout counters for deciding when shadow is safe to enforce. */
  summary(): InboundJournalSummary {
    return this.withLock(() => {
      const states: Record<InboundDeliveryState, number> = {
        received: 0,
        claimed: 0,
        dispatched: 0,
        completed: 0,
        uncertain: 0,
      };
      let duplicateObservations = 0;
      let shadowWouldSuppress = 0;
      let shadowWouldHold = 0;
      let knownLosses = 0;
      let unknownOutcomes = 0;
      let corruptRecords = this.listIssuesLocked().length;
      knownLosses += corruptRecords;
      for (const path of this.recordPaths()) {
        try {
          const record = this.readRecordPath(path);
          states[record.state] += 1;
          duplicateObservations += record.duplicates.count;
          shadowWouldSuppress += record.duplicates.shadowWouldSuppress;
          shadowWouldHold += record.duplicates.shadowWouldHold;
          if (record.failure?.semantic === "loss") knownLosses += 1;
          if (record.failure?.semantic === "outcome-unknown") unknownOutcomes += 1;
        } catch {
          corruptRecords += 1;
          knownLosses += 1;
        }
      }
      return {
        mode: this.currentMode,
        states,
        duplicateObservations,
        shadowWouldSuppress,
        shadowWouldHold,
        knownLosses,
        unknownOutcomes,
        corruptRecords,
      };
    });
  }

  private admitLocked(envelope: InboundEnvelope<Payload>): InboundAdmission<Payload> {
    validateMessageId(envelope.messageId);
    const path = this.recordPath(envelope.messageId);
    if (!existsSync(path)) {
      const at = this.timestamp();
      const duplicates: DuplicateObservations = { count: 0, shadowWouldSuppress: 0, shadowWouldHold: 0 };
      const record: InboundJournalRecord<Payload> = {
        version: 1,
        messageId: envelope.messageId,
        state: "received",
        payload: clone(envelope.payload),
        ...(envelope.sourceTimestamp == null ? {} : { sourceTimestamp: envelope.sourceTimestamp }),
        receivedAt: at,
        updatedAt: at,
        attempt: 0,
        duplicates,
        history: [{ from: null, to: "received", at }],
      };
      this.writeRecord(record);
      return {
        mode: this.currentMode,
        classification: "new",
        action: "process",
        wouldEnforce: "process",
        managed: true,
        journaled: true,
        record: clone(record),
      };
    }

    let record: InboundJournalRecord<Payload>;
    try {
      record = this.readRecordPath(path);
    } catch (cause) {
      const issue = this.quarantineCorruptLocked(path, cause);
      throw new InboundDeliveryError(
        `inbound record for ${envelope.messageId} was corrupt and quarantined at ${issue.quarantinePath}`,
        "loss",
        cause,
      );
    }
    if (record.messageId !== envelope.messageId) {
      const issue = this.quarantineCorruptLocked(path, new Error("hashed path contains a different message ID"));
      throw new InboundDeliveryError(
        `inbound record message ID mismatch; quarantined at ${issue.quarantinePath}`,
        "loss",
      );
    }

    const at = this.timestamp();
    record.duplicates.count += 1;
    record.duplicates.lastSeenAt = at;
    const unknown = record.state === "uncertain" && record.failure?.semantic === "outcome-unknown";
    const loss = record.state === "uncertain" && record.failure?.semantic === "loss";
    if (this.currentMode === "shadow") {
      if (unknown || loss) record.duplicates.shadowWouldHold += 1;
      else record.duplicates.shadowWouldSuppress += 1;
    }
    record.updatedAt = at;
    this.writeRecord(record);

    const wouldEnforce = unknown || loss ? "hold" : "suppress";
    return {
      mode: this.currentMode,
      classification: unknown ? "outcome-unknown" : loss ? "loss" : "duplicate",
      action: this.currentMode === "shadow" ? "process" : wouldEnforce,
      wouldEnforce,
      managed: false,
      journaled: true,
      failureSemantic: unknown ? "outcome-unknown" : loss ? "loss" : "duplicate",
      record: clone(record),
    };
  }

  private toUncertain(
    record: InboundJournalRecord<Payload>,
    semantic: "loss" | "outcome-unknown",
    reason: string,
  ): InboundJournalRecord<Payload> {
    if (!reason.trim()) throw new Error("uncertain reason must not be empty");
    const at = this.timestamp();
    record = this.transition(record, "uncertain", reason);
    record.uncertainAt = at;
    record.failure = { semantic, reason, at };
    delete record.claim;
    return record;
  }

  private transition(
    record: InboundJournalRecord<Payload>,
    to: InboundDeliveryState,
    reason?: string,
    owner?: string,
  ): InboundJournalRecord<Payload> {
    const at = this.timestamp();
    const from = record.state;
    record.state = to;
    record.updatedAt = at;
    record.history.push({ from, to, at, ...(reason ? { reason } : {}), ...(owner ? { owner } : {}) });
    if (record.history.length > MAX_HISTORY) record.history.splice(0, record.history.length - MAX_HISTORY);
    return record;
  }

  private requireRecordLocked(messageId: string): InboundJournalRecord<Payload> {
    validateMessageId(messageId);
    const path = this.recordPath(messageId);
    if (!existsSync(path)) throw new Error(`inbound message ${messageId} is not journaled`);
    const record = this.readRecordPath(path);
    if (record.messageId !== messageId) throw new InboundDeliveryError(`record message ID mismatch for ${messageId}`, "loss");
    return record;
  }

  private requireClaimLocked(
    messageId: string,
    claimToken: string,
    states: InboundDeliveryState[],
  ): InboundJournalRecord<Payload> {
    const record = this.requireRecordLocked(messageId);
    this.requireState(record, states, "claim transition");
    if (!record.claim || record.claim.token !== claimToken) {
      throw new Error(`stale or invalid claim token for inbound message ${messageId}`);
    }
    return record;
  }

  private requireState(
    record: InboundJournalRecord<Payload>,
    allowed: InboundDeliveryState[],
    operation: string,
  ): void {
    if (!allowed.includes(record.state)) {
      throw new Error(`${operation} requires state ${allowed.join(" or ")}; ${record.messageId} is ${record.state}`);
    }
  }

  private writeRecord(record: InboundJournalRecord<Payload>): void {
    this.ensureLayout();
    // JSON serialization here validates that Payload is durably representable
    // before the original file is touched.
    const recordJson = JSON.stringify(record);
    const stored: StoredRecord<Payload> = {
      format: "pager-inbound-journal",
      formatVersion: 1,
      record,
      checksum: sha256(recordJson),
    };
    this.atomicWrite(this.recordPath(record.messageId), `${JSON.stringify(stored)}\n`, this.recordsDir);
  }

  private readRecordPath(path: string): InboundJournalRecord<Payload> {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      throw new Error(`unreadable journal record ${basename(path)}: ${errorText(cause)}`);
    }
    let stored: StoredRecord<Payload>;
    try {
      stored = JSON.parse(raw) as StoredRecord<Payload>;
    } catch (cause) {
      throw new Error(`invalid JSON in journal record ${basename(path)}: ${errorText(cause)}`);
    }
    if (stored?.format !== "pager-inbound-journal" || stored.formatVersion !== 1 || !isRecord(stored.record)) {
      throw new Error(`unsupported or malformed journal record ${basename(path)}`);
    }
    const actual = sha256(JSON.stringify(stored.record));
    if (stored.checksum !== actual) throw new Error(`checksum mismatch in journal record ${basename(path)}`);
    if (this.recordPath(stored.record.messageId) !== path) {
      throw new Error(`message ID/path mismatch in journal record ${basename(path)}`);
    }
    return stored.record;
  }

  private quarantineCorruptLocked(path: string, cause: unknown): JournalIssue {
    this.ensureLayout();
    const detectedAt = this.timestamp();
    const quarantinePath = join(
      this.quarantineDir,
      `${basename(path)}.${this.now().getTime()}.${this.makeToken()}.corrupt`,
    );
    try {
      renameSync(path, quarantinePath);
      fsyncDirectory(this.recordsDir);
      fsyncDirectory(this.quarantineDir);
    } catch (moveCause) {
      throw new InboundDeliveryError(
        `corrupt inbound record could not be quarantined: ${errorText(moveCause)}`,
        "loss",
        moveCause,
      );
    }
    const issue: JournalIssue = {
      semantic: "loss",
      reason: "corrupt-record",
      path,
      detectedAt,
      detail: errorText(cause),
      quarantinePath,
    };
    // Preserve the semantic separately from the corrupt bytes, so a future
    // restart can report the loss without trying to parse the damaged record.
    this.atomicWrite(`${quarantinePath}.issue.json`, `${JSON.stringify(issue)}\n`, this.quarantineDir);
    return issue;
  }

  private listIssuesLocked(): JournalIssue[] {
    this.ensureLayout();
    const names = readdirSync(this.quarantineDir).sort();
    const issues: JournalIssue[] = [];
    const covered = new Set<string>();
    for (const name of names.filter((entry) => entry.endsWith(".corrupt.issue.json"))) {
      try {
        const issue = JSON.parse(readFileSync(join(this.quarantineDir, name), "utf8")) as JournalIssue;
        if (issue?.semantic !== "loss" || typeof issue.detail !== "string") throw new Error("malformed issue");
        if (issue.quarantinePath) covered.add(issue.quarantinePath);
        issues.push(issue);
      } catch (cause) {
        issues.push({
          semantic: "loss",
          reason: "unreadable-record",
          path: join(this.quarantineDir, name),
          detectedAt: this.timestamp(),
          detail: `unreadable corruption issue sidecar: ${errorText(cause)}`,
        });
      }
    }
    // If disk-full struck after the corrupt bytes were moved but before the
    // sidecar was durable, the raw quarantine file is still a persistent loss
    // signal. Synthesize a conservative issue instead of overlooking it.
    for (const name of names.filter((entry) => entry.endsWith(".corrupt"))) {
      const quarantinePath = join(this.quarantineDir, name);
      if (covered.has(quarantinePath)) continue;
      issues.push({
        semantic: "loss",
        reason: "corrupt-record",
        path: quarantinePath,
        detectedAt: new Date(statSync(quarantinePath).mtimeMs).toISOString(),
        detail: "quarantined corrupt record has no readable issue sidecar",
        quarantinePath,
      });
    }
    return issues;
  }

  private recordPaths(): string[] {
    this.ensureLayout();
    return readdirSync(this.recordsDir)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort()
      .map((name) => join(this.recordsDir, name));
  }

  private recordPath(messageId: string): string {
    return join(this.recordsDir, `${sha256(messageId)}${RECORD_SUFFIX}`);
  }

  private atomicWrite(destination: string, contents: string, parentDir: string): void {
    const tmp = `${destination}.tmp.${process.pid}.${this.makeToken()}`;
    let fd: number | undefined;
    let renamed = false;
    try {
      this.faultInjector?.onWrite?.("before-temp-write", destination);
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, contents, "utf8");
      fsyncSync(fd);
      this.faultInjector?.onWrite?.("after-temp-fsync", destination);
      closeSync(fd);
      fd = undefined;
      this.faultInjector?.onWrite?.("before-rename", destination);
      renameSync(tmp, destination);
      renamed = true;
      this.faultInjector?.onWrite?.("after-rename", destination);
      fsyncDirectory(parentDir);
      this.faultInjector?.onWrite?.("after-directory-fsync", destination);
    } finally {
      if (fd != null) {
        try { closeSync(fd); } catch { /* preserve the primary error */ }
      }
      if (!renamed) {
        try { unlinkSync(tmp); } catch { /* absent or fault-injected */ }
      }
    }
  }

  private ensureLayout(): void {
    mkdirSync(this.options.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
  }

  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): void {
    this.ensureLayout();
    const started = Date.now();
    for (;;) {
      try {
        mkdirSync(this.lockDir, { mode: 0o700 });
        writeFileSync(
          join(this.lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          { mode: 0o600 },
        );
        return;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") throw cause;
        if (this.lockIsStale()) {
          const stale = `${this.lockDir}.stale.${process.pid}.${this.makeToken()}`;
          try {
            renameSync(this.lockDir, stale);
            rmSync(stale, { recursive: true, force: true });
            continue;
          } catch {
            // Another contender recovered it; retry until timeout.
          }
        }
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw new Error(`timed out acquiring inbound journal lock ${this.lockDir}`);
        }
        Atomics.wait(sleepArray, 0, 0, 10);
      }
    }
  }

  private lockIsStale(): boolean {
    try {
      const owner = JSON.parse(readFileSync(join(this.lockDir, "owner.json"), "utf8")) as {
        pid?: unknown;
        acquiredAt?: unknown;
      };
      if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid)) {
        try {
          process.kill(owner.pid, 0);
          const acquiredAt = typeof owner.acquiredAt === "string" ? Date.parse(owner.acquiredAt) : Number.NaN;
          return Number.isFinite(acquiredAt) && Date.now() - acquiredAt > this.staleLockMs;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code === "ESRCH") return true;
          return false;
        }
      }
      return Date.now() - statSync(this.lockDir).mtimeMs > this.staleLockMs;
    } catch {
      // mkdir succeeded but the owner write may have been interrupted. Give it
      // a short grace period before recovering that half-created lock.
      try { return Date.now() - statSync(this.lockDir).mtimeMs > Math.min(this.staleLockMs, 1_000); }
      catch { return false; }
    }
  }

  private releaseLock(): void {
    try { unlinkSync(join(this.lockDir, "owner.json")); } catch { /* already recovered */ }
    try { rmdirSync(this.lockDir); } catch { /* already recovered */ }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function validateMessageId(messageId: string): void {
  if (typeof messageId !== "string" || messageId.length === 0) throw new Error("messageId must not be empty");
  if (messageId.length > 1_024) throw new Error("messageId must not exceed 1024 characters");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  // The payload must be JSON-persistable; JSON cloning also prevents callers
  // from mutating the checksummed in-memory record after a method returns.
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is InboundJournalRecord<unknown> {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<InboundJournalRecord<unknown>>;
  return r.version === 1
    && typeof r.messageId === "string"
    && ["received", "claimed", "dispatched", "completed", "uncertain"].includes(String(r.state))
    && typeof r.receivedAt === "string"
    && typeof r.updatedAt === "string"
    && typeof r.attempt === "number"
    && !!r.duplicates
    && typeof r.duplicates.count === "number"
    && Array.isArray(r.history);
}

function replayOf<Payload>(record: InboundJournalRecord<Payload>): ReplayEntry<Payload> {
  return {
    messageId: record.messageId,
    payload: clone(record.payload),
    ...(record.sourceTimestamp == null ? {} : { sourceTimestamp: record.sourceTimestamp }),
    receivedAt: record.receivedAt,
    attempt: record.attempt,
  };
}

function replayOrder<Payload>(a: ReplayEntry<Payload>, b: ReplayEntry<Payload>): number {
  return a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId);
}

function recordOrder<Payload>(a: InboundJournalRecord<Payload>, b: InboundJournalRecord<Payload>): number {
  return a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
