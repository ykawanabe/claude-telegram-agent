import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
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

function isOutboundMessage(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.kind !== "text" && message.kind !== "buttons") return false;
  if (typeof message.text !== "string" || message.to == null || typeof message.to !== "object") return false;
  if (message.kind === "buttons"
    && (!Array.isArray(message.buttons) || !message.buttons.every((button) => typeof button === "string"))) return false;
  const to = message.to as Record<string, unknown>;
  return typeof to.channel === "string"
    && ["telegram", "slack", "discord", "line"].includes(to.channel);
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
    && Number.isFinite(r.createdAt)
    && Number.isFinite(r.updatedAt);
}

/**
 * File-per-record durable storage. Terminal records remain on disk, making the
 * caller's message/deduplication key durable across restarts. Writes use
 * tempfile + fsync + rename; the old state is removed only after the new state
 * is durable. If a crash leaves both copies, terminal state wins on recovery.
 */
export class FileOutboxStore {
  readonly rootDir: string;
  private readonly pendingDir: string;
  private readonly completedDir: string;
  private readonly deadLetterDir: string;
  private readonly corruptDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.pendingDir = join(rootDir, "pending");
    this.completedDir = join(rootDir, "completed");
    this.deadLetterDir = join(rootDir, "dead-letter");
    this.corruptDir = join(rootDir, "corrupt");
    for (const dir of [rootDir, this.pendingDir, this.completedDir, this.deadLetterDir, this.corruptDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
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

    const bucket = stateBucket(record.state);
    const destinationDir = this.directory(bucket);
    const destination = join(destinationDir, `${record.id}.json`);
    const tmp = join(destinationDir, `.${record.id}.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
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
    for (const name of this.jsonNames(this.pendingDir)) {
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
    for (const name of this.jsonNames(dir)) {
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

  private jsonNames(dir: string): string[] {
    try {
      return readdirSync(dir).filter((name) => SAFE_ID.test(name.slice(0, -5)) && name.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  private readRecord(path: string): OutboxRecord | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isOutboxRecord(parsed)) throw new Error("record failed schema validation");
      return parsed;
    } catch (error) {
      this.quarantine(path, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private quarantine(path: string, reason: string): void {
    const name = basename(path);
    const destination = join(this.corruptDir, `${name}.${Date.now()}.${randomUUID()}.corrupt`);
    try {
      renameSync(path, destination);
      writeFileSync(`${destination}.reason`, `${reason}\n`, { mode: 0o600 });
      this.fsyncDirectory(this.corruptDir);
    } catch {
      // If quarantine itself fails (e.g. disk full), leave the source intact.
      // It is still never returned as sendable work.
    }
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
