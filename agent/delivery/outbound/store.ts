import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  OUTBOX_SCHEMA_VERSION,
  type OutboxRecord,
  type OutboxState,
} from "./types";

const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

export const DEFAULT_OUTBOX_MAX_RECORD_BYTES = 1_048_576;
export const DEFAULT_OUTBOX_MAX_PENDING_RECORDS = 10_000;
export const DEFAULT_OUTBOX_MAX_LIST_RECORDS = 10_000;
export const DEFAULT_OUTBOX_MAX_COMPLETED_RECORDS = 10_000;
export const DEFAULT_OUTBOX_MAX_DEAD_LETTER_RECORDS = 10_000;
export const DEFAULT_OUTBOX_MAX_CORRUPT_RECORDS = 1_000;

export interface FileOutboxStoreOptions {
  /** Maximum UTF-8 bytes for one durable JSON record. */
  maxRecordBytes?: number;
  /** Maximum records admitted to the pending queue. */
  maxPendingRecords?: number;
  /** Maximum terminal records materialized by one list call. */
  maxListRecords?: number;
  /** Maximum completed records retained for result lookup/deduplication. */
  maxCompletedRecords?: number;
  /** Maximum dead letters retained for operator inspection. */
  maxDeadLetterRecords?: number;
  /** Maximum corrupt records retained for diagnosis. */
  maxCorruptRecords?: number;
}

export class OutboxCapacityError extends Error {
  readonly code = "OUTBOX_CAPACITY";

  constructor(message: string) {
    super(message);
    this.name = "OutboxCapacityError";
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`invalid outbox id: ${JSON.stringify(id)}`);
  }
}

function stateBucket(state: OutboxState): "pending" | "completed" | "dead-letter" {
  if (state === "delivered") return "completed";
  if (state === "dead_letter") return "dead-letter";
  return "pending";
}

interface RetentionEntry {
  path: string;
  name: string;
  modifiedAt: number;
}

function olderThan(left: RetentionEntry, right: RetentionEntry): boolean {
  return left.modifiedAt < right.modifiedAt
    || (left.modifiedAt === right.modifiedAt && left.name < right.name);
}

function heapPushOldestFirst(heap: RetentionEntry[], entry: RetentionEntry): void {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!olderThan(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapReplaceOldest(heap: RetentionEntry[], entry: RetentionEntry): RetentionEntry {
  const removed = heap[0];
  heap[0] = entry;
  let index = 0;
  while (true) {
    const left = (index * 2) + 1;
    const right = left + 1;
    let oldest = index;
    if (left < heap.length && olderThan(heap[left], heap[oldest])) oldest = left;
    if (right < heap.length && olderThan(heap[right], heap[oldest])) oldest = right;
    if (oldest === index) break;
    [heap[index], heap[oldest]] = [heap[oldest], heap[index]];
    index = oldest;
  }
  return removed;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isChatAddress(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const address = value as Record<string, unknown>;
  switch (address.channel) {
    case "telegram":
      return Number.isSafeInteger(address.chatId)
        && (address.threadId == null || Number.isSafeInteger(address.threadId));
    case "slack":
      return typeof address.teamId === "string"
        && typeof address.channelId === "string"
        && isOptionalString(address.threadTs);
    case "discord":
      return (address.guildId == null || typeof address.guildId === "string")
        && typeof address.channelId === "string";
    case "line":
      return ["user", "group", "room"].includes(String(address.targetKind))
        && typeof address.targetId === "string";
    default:
      return false;
  }
}

function isOutboundButton(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value == null || typeof value !== "object") return false;
  const button = value as Record<string, unknown>;
  return typeof button.label === "string" && typeof button.action === "string";
}

function isOutboundMessage(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.kind !== "text" && message.kind !== "buttons") return false;
  if (typeof message.text !== "string" || !isChatAddress(message.to) || !isOptionalString(message.deliveryKey)) return false;
  if (message.kind === "buttons"
    && (!Array.isArray(message.buttons) || !message.buttons.every(isOutboundButton))) return false;
  return true;
}

function isOutboxRecord(value: unknown): value is OutboxRecord {
  if (value == null || typeof value !== "object") return false;
  const r = value as Partial<OutboxRecord>;
  return r.schemaVersion === OUTBOX_SCHEMA_VERSION
    && typeof r.id === "string"
    && SAFE_ID.test(r.id)
    && typeof r.mode === "string"
    && (r.mode === "shadow" || r.mode === "enforced")
    && isOutboundMessage(r.message)
    && typeof r.state === "string"
    && ["queued", "sending", "retry_wait", "delivered", "dead_letter", "uncertain"].includes(r.state)
    && Number.isSafeInteger(r.attempts)
    && (r.attempts ?? -1) >= 0
    && Number.isSafeInteger(r.createdAt)
    && (r.createdAt ?? -1) >= 0
    && Number.isSafeInteger(r.updatedAt)
    && (r.updatedAt ?? -1) >= 0
    && (r.nextAttemptAt == null
      || (Number.isSafeInteger(r.nextAttemptAt) && r.nextAttemptAt >= 0))
    && isOptionalString(r.deduplicationKey);
}

/**
 * File-per-record durable storage. Terminal records remain on disk up to the
 * configured retention, making recent message/deduplication keys durable
 * across restarts. Writes use tempfile + fsync + rename; the old state is
 * removed only after the new state is durable. If a crash leaves both copies,
 * terminal state wins on recovery.
 */
export class FileOutboxStore {
  readonly rootDir: string;
  private readonly pendingDir: string;
  private readonly completedDir: string;
  private readonly deadLetterDir: string;
  private readonly corruptDir: string;
  private readonly maxRecordBytes: number;
  private readonly maxPendingRecords: number;
  private readonly maxListRecords: number;
  private readonly maxCompletedRecords: number;
  private readonly maxDeadLetterRecords: number;
  private readonly maxCorruptRecords: number;

  constructor(rootDir: string, options: FileOutboxStoreOptions = {}) {
    this.rootDir = rootDir;
    this.maxRecordBytes = positiveSafeInteger(
      options.maxRecordBytes ?? DEFAULT_OUTBOX_MAX_RECORD_BYTES,
      "outbox maxRecordBytes",
    );
    this.maxPendingRecords = positiveSafeInteger(
      options.maxPendingRecords ?? DEFAULT_OUTBOX_MAX_PENDING_RECORDS,
      "outbox maxPendingRecords",
    );
    this.maxListRecords = positiveSafeInteger(
      options.maxListRecords ?? DEFAULT_OUTBOX_MAX_LIST_RECORDS,
      "outbox maxListRecords",
    );
    this.maxCompletedRecords = positiveSafeInteger(
      options.maxCompletedRecords ?? DEFAULT_OUTBOX_MAX_COMPLETED_RECORDS,
      "outbox maxCompletedRecords",
    );
    this.maxDeadLetterRecords = positiveSafeInteger(
      options.maxDeadLetterRecords ?? DEFAULT_OUTBOX_MAX_DEAD_LETTER_RECORDS,
      "outbox maxDeadLetterRecords",
    );
    this.maxCorruptRecords = positiveSafeInteger(
      options.maxCorruptRecords ?? DEFAULT_OUTBOX_MAX_CORRUPT_RECORDS,
      "outbox maxCorruptRecords",
    );
    this.pendingDir = join(rootDir, "pending");
    this.completedDir = join(rootDir, "completed");
    this.deadLetterDir = join(rootDir, "dead-letter");
    this.corruptDir = join(rootDir, "corrupt");
    for (const dir of [rootDir, this.pendingDir, this.completedDir, this.deadLetterDir, this.corruptDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    for (const dir of [this.pendingDir, this.completedDir, this.deadLetterDir]) {
      this.cleanupOrphanTemps(dir);
    }
    this.retainNewest(this.completedDir, this.maxCompletedRecords, (name) => name.endsWith(".json"));
    this.retainNewest(this.deadLetterDir, this.maxDeadLetterRecords, (name) => name.endsWith(".json"));
    this.retainNewest(this.corruptDir, this.maxCorruptRecords, (name) => name.endsWith(".corrupt"), true);
    this.cleanupOrphanCorruptReasons();
  }

  static idForDeduplicationKey(key: string): string {
    return `d-${createHash("sha256").update(key).digest("hex")}`;
  }

  createId(): string {
    return randomUUID();
  }

  get(id: string): OutboxRecord | null {
    assertSafeId(id);
    // A crash during a state move can leave two copies. A confirmed terminal
    // result must win over stale pending work to prevent a duplicate send.
    for (const dir of [this.completedDir, this.deadLetterDir, this.pendingDir]) {
      const record = this.readRecord(join(dir, `${id}.json`));
      if (record) return record;
    }
    return null;
  }

  save(record: OutboxRecord): void {
    const recordId = record.id;
    assertSafeId(recordId);
    if (!isOutboxRecord(record)) throw new Error(`invalid outbox record: ${recordId}`);

    const serialized = `${JSON.stringify(record)}\n`;
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > this.maxRecordBytes) {
      throw new OutboxCapacityError(
        `outbox record exceeds maxRecordBytes (${serializedBytes} > ${this.maxRecordBytes}): ${recordId}`,
      );
    }

    const bucket = stateBucket(record.state);
    if (bucket === "pending" && !this.existsInAnyBucket(record.id)) {
      const pendingCount = this.jsonNames(
        this.pendingDir,
        this.maxPendingRecords,
        "pending queue",
      ).length;
      if (pendingCount >= this.maxPendingRecords) {
        throw new OutboxCapacityError(
          `outbox pending capacity reached (${pendingCount}/${this.maxPendingRecords})`,
        );
      }
    }
    const destinationDir = this.directory(bucket);
    const destination = join(destinationDir, `${record.id}.json`);
    if (bucket === "completed" && !existsSync(destination)) {
      this.retainNewest(this.completedDir, this.maxCompletedRecords - 1, (name) => name.endsWith(".json"));
    } else if (bucket === "dead-letter" && !existsSync(destination)) {
      this.retainNewest(this.deadLetterDir, this.maxDeadLetterRecords - 1, (name) => name.endsWith(".json"));
    }
    const tmp = join(destinationDir, `.${record.id}.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, destination);
      this.fsyncDirectory(destinationDir);
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* best effort temp cleanup */ }
      throw error;
    }

    for (const other of [this.pendingDir, this.completedDir, this.deadLetterDir]) {
      if (other === destinationDir) continue;
      try { unlinkSync(join(other, `${record.id}.json`)); } catch { /* absent or prior cleanup */ }
    }
  }

  listPending(): OutboxRecord[] {
    const records: OutboxRecord[] = [];
    for (const name of this.jsonNames(this.pendingDir, this.maxPendingRecords, "pending queue")) {
      const id = name.slice(0, -5);
      // Terminal copies left by a crash win; don't replay stale pending work.
      if (existsSync(join(this.completedDir, name)) || existsSync(join(this.deadLetterDir, name))) {
        try { unlinkSync(join(this.pendingDir, name)); } catch { /* cleanup raced */ }
        continue;
      }
      const record = this.readRecord(join(this.pendingDir, name));
      if (record && record.id === id) records.push(record);
      else if (record) this.quarantine(join(this.pendingDir, name), "filename-id-mismatch");
    }
    return records.sort((a, b) => {
      const aDue = a.nextAttemptAt ?? a.createdAt;
      const bDue = b.nextAttemptAt ?? b.createdAt;
      return aDue - bDue || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });
  }

  listDeadLetters(): OutboxRecord[] {
    return this.listBucket(this.deadLetterDir);
  }

  listCompleted(): OutboxRecord[] {
    return this.listBucket(this.completedDir);
  }

  private listBucket(dir: string): OutboxRecord[] {
    const out: OutboxRecord[] = [];
    for (const name of this.jsonNames(dir, this.maxListRecords, "outbox list")) {
      const record = this.readRecord(join(dir, name));
      if (record) out.push(record);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private directory(bucket: "pending" | "completed" | "dead-letter"): string {
    switch (bucket) {
      case "pending": return this.pendingDir;
      case "completed": return this.completedDir;
      case "dead-letter": return this.deadLetterDir;
    }
  }

  private jsonNames(dir: string, limit: number, label: string): string[] {
    let handle: ReturnType<typeof opendirSync> | undefined;
    try {
      handle = opendirSync(dir);
      const names: string[] = [];
      let entry: ReturnType<typeof handle.readSync>;
      while ((entry = handle.readSync()) != null) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        if (!SAFE_ID.test(entry.name.slice(0, -5))) continue;
        names.push(entry.name);
        if (names.length > limit) {
          throw new OutboxCapacityError(`${label} exceeds configured limit (${limit})`);
        }
      }
      return names.sort();
    } catch (error) {
      if (error instanceof OutboxCapacityError) throw error;
      return [];
    } finally {
      try { handle?.closeSync(); } catch { /* already closed */ }
    }
  }

  private readRecord(path: string): OutboxRecord | null {
    if (!existsSync(path)) return null;
    try {
      const size = statSync(path).size;
      if (size > this.maxRecordBytes) {
        throw new OutboxCapacityError(
          `record exceeds maxRecordBytes (${size} > ${this.maxRecordBytes})`,
        );
      }
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isOutboxRecord(parsed)) throw new Error("record failed schema validation");
      return parsed;
    } catch (error) {
      this.quarantine(path, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private existsInAnyBucket(id: string): boolean {
    return [this.pendingDir, this.completedDir, this.deadLetterDir]
      .some((dir) => existsSync(join(dir, `${id}.json`)));
  }

  private quarantine(path: string, reason: string): void {
    const name = basename(path);
    const nameHash = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const diagnosticName = `${name.slice(0, 80)}.${nameHash}`;
    const destination = join(this.corruptDir, `${diagnosticName}.${Date.now()}.${randomUUID()}.corrupt`);
    try {
      this.retainNewest(this.corruptDir, this.maxCorruptRecords - 1, (entry) => entry.endsWith(".corrupt"), true);
      const size = statSync(path).size;
      if (size > this.maxRecordBytes) {
        unlinkSync(path);
        writeFileSync(destination, "oversized corrupt outbox record discarded\n", { mode: 0o600 });
      } else {
        renameSync(path, destination);
      }
      const diagnosticReason = `source=${name}; ${reason}`.slice(0, 1_024);
      writeFileSync(`${destination}.reason`, `${diagnosticReason}\n`, { mode: 0o600 });
      this.fsyncDirectory(this.corruptDir);
    } catch {
      // If quarantine itself fails (e.g. disk full), leave the source intact.
      // It is still never returned as sendable work.
    }
  }

  private cleanupOrphanTemps(dir: string): void {
    let handle: ReturnType<typeof opendirSync> | undefined;
    let changed = false;
    try {
      handle = opendirSync(dir);
      let entry = handle.readSync();
      while (entry != null) {
        if (entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
          unlinkSync(join(dir, entry.name));
          changed = true;
        }
        entry = handle.readSync();
      }
    } catch (error) {
      throw new OutboxCapacityError(
        `unable to clean orphan outbox temp files: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try { handle?.closeSync(); } catch { /* already closed */ }
    }
    if (changed) this.fsyncDirectory(dir);
  }

  private cleanupOrphanCorruptReasons(): void {
    let handle: ReturnType<typeof opendirSync> | undefined;
    let changed = false;
    try {
      handle = opendirSync(this.corruptDir);
      let entry = handle.readSync();
      while (entry != null) {
        if (entry.isFile() && entry.name.endsWith(".corrupt.reason")) {
          const primary = join(this.corruptDir, entry.name.slice(0, -7));
          if (!existsSync(primary)) {
            unlinkSync(join(this.corruptDir, entry.name));
            changed = true;
          }
        }
        entry = handle.readSync();
      }
    } catch (error) {
      throw new OutboxCapacityError(
        `unable to clean orphan corrupt reasons: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try { handle?.closeSync(); } catch { /* already closed */ }
    }
    if (changed) this.fsyncDirectory(this.corruptDir);
  }

  /**
   * Keep only the newest terminal diagnostics. The min-heap is bounded by the
   * configured retention, so recovery does not materialize an unbounded dir.
   */
  private retainNewest(
    dir: string,
    limit: number,
    matches: (name: string) => boolean,
    removeReasonCompanion = false,
  ): void {
    let handle: ReturnType<typeof opendirSync> | undefined;
    const retained: RetentionEntry[] = [];
    let changed = false;
    const remove = (entry: RetentionEntry): void => {
      unlinkSync(entry.path);
      if (removeReasonCompanion) {
        try { unlinkSync(`${entry.path}.reason`); } catch { /* companion may not exist after a crash */ }
      }
      changed = true;
    };

    try {
      handle = opendirSync(dir);
      let dirent = handle.readSync();
      while (dirent != null) {
        if (dirent.isFile() && matches(dirent.name)) {
          const path = join(dir, dirent.name);
          const candidate: RetentionEntry = {
            path,
            name: dirent.name,
            modifiedAt: statSync(path).mtimeMs,
          };
          if (limit === 0) {
            remove(candidate);
          } else if (retained.length < limit) {
            heapPushOldestFirst(retained, candidate);
          } else if (olderThan(retained[0], candidate)) {
            remove(heapReplaceOldest(retained, candidate));
          } else {
            remove(candidate);
          }
        }
        dirent = handle.readSync();
      }
    } catch (error) {
      throw new OutboxCapacityError(
        `unable to enforce outbox retention: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try { handle?.closeSync(); } catch { /* already closed */ }
    }
    if (changed) this.fsyncDirectory(dir);
  }

  private fsyncDirectory(dir: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(dir, "r");
      fsyncSync(fd);
    } catch {
      // Some filesystems do not allow fsync on a directory. The file itself was
      // fsynced, so portability wins over converting a successful write into an
      // apparent failure.
    } finally {
      if (fd != null) closeSync(fd);
    }
  }
}
