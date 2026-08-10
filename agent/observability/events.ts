import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_MAX_FILES = 4;
export const DEFAULT_EVENT_LINE_MAX_BYTES = 256 * 1024;
export const DEFAULT_MEMORY_EVENT_CAPACITY = 4_096;

export type ReliabilityMode = "shadow" | "enforced";

export interface ObservabilityEventData {
  "queue.depth": {
    queue: string;
    depth: number;
    capacity?: number;
  };
  "turn.started": {
    turnId: string;
    threadId: string;
  };
  "turn.finished": {
    turnId: string;
    threadId: string;
    outcome: "completed" | "timeout" | "failed" | "uncertain";
    latencyMs: number;
    matchedStart: boolean;
  };
  "process.spawn": {
    component: string;
    success: boolean;
    instanceId?: string;
  };
  "process.crash": {
    component: string;
    count: number;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  };
  "telegram.request": {
    operation: string;
    ok: boolean;
    status?: number;
    latencyMs?: number;
    retryAfterMs?: number;
  };
  "process.rss": {
    rssBytes: number;
  };
  "observability.sampling_error": {
    sampler: string;
    error: string;
  };
  "reliability.mode_selected": {
    mode: ReliabilityMode;
    origin: "default" | "environment" | "explicit";
  };
  "reliability.policy_evaluated": {
    mode: ReliabilityMode;
    allowed: boolean;
    wouldBlock: boolean;
    evidenceSufficient: boolean;
    missingEvidence: Array<{
      metric: string;
      actual: number;
      required: number;
    }>;
    consecutiveHealthyWindows: number;
    promotionReady: boolean;
    violations: Array<{
      check: string;
      actual: number;
      threshold: number;
    }>;
  };
  "fault.injected": {
    point: string;
    fault: "timeout" | "disk-full" | "kill" | "corrupt-state";
  };
}

export type ObservabilityEventType = keyof ObservabilityEventData;

export interface EventContext {
  traceId?: string;
  messageId?: string;
  threadId?: string;
}

export type StructuredEvent<K extends ObservabilityEventType = ObservabilityEventType> = {
  schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  id: string;
  sequence: number;
  timestamp: string;
  source: string;
  type: K;
  context?: EventContext;
  data: ObservabilityEventData[K];
};

/** A sink may throw (ENOSPC, permissions, corrupt descriptor). The reporter
 * contains that failure so instrumentation never changes the observed path. */
export interface StructuredEventSink {
  write(event: StructuredEvent): void;
}

export class MemoryEventSink implements StructuredEventSink {
  private readonly buffer: StructuredEvent[] = [];
  private nextIndex = 0;
  private dropped = 0;

  constructor(readonly capacity = DEFAULT_MEMORY_EVENT_CAPACITY) {
    assertPositiveInteger("memory event capacity", capacity);
  }

  write(event: StructuredEvent): void {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(event);
      return;
    }
    this.buffer[this.nextIndex] = event;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.dropped += 1;
  }

  /** Retained events in emission order. The returned copy is always bounded by
   * capacity, so consumers cannot mutate the sink's ring buffer. */
  get events(): StructuredEvent[] {
    if (this.buffer.length < this.capacity || this.nextIndex === 0) return [...this.buffer];
    return [...this.buffer.slice(this.nextIndex), ...this.buffer.slice(0, this.nextIndex)];
  }

  diagnostics(): { retained: number; dropped: number; capacity: number } {
    return { retained: this.buffer.length, dropped: this.dropped, capacity: this.capacity };
  }
}

export class CompositeEventSink implements StructuredEventSink {
  constructor(private readonly sinks: StructuredEventSink[]) {}

  write(event: StructuredEvent): void {
    const failures: unknown[] = [];
    for (const sink of this.sinks) {
      try {
        sink.write(event);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} observability sink(s) failed`);
    }
  }
}

export class JsonlEventSink implements StructuredEventSink {
  private initialized = false;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxEventBytes: number;

  constructor(
    readonly path: string,
    options: {
      maxBytes?: number;
      /** Total files including the active path. */
      maxFiles?: number;
      maxEventBytes?: number;
    } = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_EVENT_LOG_MAX_FILES;
    this.maxEventBytes = options.maxEventBytes ?? Math.min(DEFAULT_EVENT_LINE_MAX_BYTES, this.maxBytes);
    assertPositiveInteger("event log maxBytes", this.maxBytes);
    assertPositiveInteger("event log maxFiles", this.maxFiles);
    assertPositiveInteger("event log maxEventBytes", this.maxEventBytes);
    if (this.maxEventBytes > this.maxBytes) throw new Error("event log maxEventBytes must not exceed maxBytes");
  }

  write(event: StructuredEvent): void {
    // Lazy initialization keeps mkdir failures (including ENOSPC) inside the
    // reporter's non-throwing write boundary.
    if (!this.initialized) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.secureAndBoundExisting(this.path);
      for (let suffix = 1; suffix < this.maxFiles; suffix += 1) {
        this.secureAndBoundExisting(`${this.path}.${suffix}`);
      }
      this.initialized = true;
    }
    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > this.maxEventBytes) {
      throw new Error(`observability event is ${lineBytes} bytes (max ${this.maxEventBytes})`);
    }
    const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentBytes + lineBytes > this.maxBytes) this.rotate();
    appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
  }

  private rotate(): void {
    if (this.maxFiles === 1) {
      if (existsSync(this.path)) unlinkSync(this.path);
      return;
    }
    const oldest = `${this.path}.${this.maxFiles - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let suffix = this.maxFiles - 2; suffix >= 1; suffix -= 1) {
      const source = `${this.path}.${suffix}`;
      if (existsSync(source)) renameSync(source, `${this.path}.${suffix + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
  }

  /** Migrates a pre-bound legacy file on first write without ever reading more
   * than maxBytes. A partial oldest line is discarded. */
  private secureAndBoundExisting(path: string): void {
    if (!existsSync(path)) return;
    chmodSync(path, 0o600);
    const size = statSync(path).size;
    if (size <= this.maxBytes) return;
    const descriptor = openSync(path, "r");
    const bytes = Buffer.allocUnsafe(this.maxBytes);
    let bytesRead = 0;
    try {
      while (bytesRead < this.maxBytes) {
        const count = readSync(
          descriptor,
          bytes,
          bytesRead,
          this.maxBytes - bytesRead,
          size - this.maxBytes + bytesRead,
        );
        if (count === 0) break;
        bytesRead += count;
      }
    } finally {
      closeSync(descriptor);
    }
    const retained = bytes.subarray(0, bytesRead);
    const newline = retained.indexOf(0x0a);
    const completeLines = newline < 0 ? Buffer.alloc(0) : retained.subarray(newline + 1);
    writeFileSync(path, completeLines, { mode: 0o600 });
  }
}

export interface ReporterDiagnostics {
  emitted: number;
  sinkFailures: number;
  lastSinkError?: string;
}

export interface StructuredEventReporterOptions {
  source: string;
  sink: StructuredEventSink;
  now?: () => number;
  bootId?: string;
  /** Optional emergency path, normally stderr. It must not throw. */
  onSinkError?: (error: unknown, event: StructuredEvent) => void;
}

/** Creates ordered, schema-versioned event envelopes. Sink failures are
 * observable through diagnostics but never escape emit(). */
export class StructuredEventReporter {
  private sequence = 0;
  private sinkFailures = 0;
  private lastSinkError: string | undefined;
  private readonly now: () => number;
  private readonly bootId: string;

  constructor(private readonly options: StructuredEventReporterOptions) {
    this.now = options.now ?? Date.now;
    this.bootId = options.bootId ?? crypto.randomUUID();
  }

  emit<K extends ObservabilityEventType>(
    type: K,
    data: ObservabilityEventData[K],
    context?: EventContext,
  ): StructuredEvent<K> {
    const sequence = ++this.sequence;
    const event: StructuredEvent<K> = {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      id: `${this.bootId}:${sequence}`,
      sequence,
      timestamp: new Date(this.now()).toISOString(),
      source: this.options.source,
      type,
      ...(context ? { context } : {}),
      data,
    };
    try {
      this.options.sink.write(event as StructuredEvent);
    } catch (error) {
      this.sinkFailures += 1;
      this.lastSinkError = error instanceof Error ? error.message : String(error);
      try {
        this.options.onSinkError?.(error, event as StructuredEvent);
      } catch {
        // The final diagnostic path is deliberately contained as well.
      }
    }
    return event;
  }

  diagnostics(): ReporterDiagnostics {
    return {
      emitted: this.sequence,
      sinkFailures: this.sinkFailures,
      ...(this.lastSinkError ? { lastSinkError: this.lastSinkError } : {}),
    };
  }
}

export interface ReadEventLogResult {
  events: StructuredEvent[];
  corruptLines: Array<{ line: number; error: string }>;
  /** Prefix omitted to keep reader memory finite. This may include one partial
   * line discarded at the tail-read boundary. */
  truncatedPrefixBytes: number;
}

/** Reads as much of an append-only log as is valid. A torn final write or a
 * corrupt line is reported separately so prior events remain useful. */
export function readEventLog(
  path: string,
  options: { onCorrupt?: "skip" | "throw"; maxBytes?: number } = {},
): ReadEventLogResult {
  const maxBytes = options.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES;
  assertPositiveInteger("event log read maxBytes", maxBytes);
  const size = statSync(path).size;
  const readBytes = Math.min(size, maxBytes);
  const offset = size - readBytes;
  const bytes = Buffer.allocUnsafe(readBytes);
  const descriptor = openSync(path, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < readBytes) {
      const count = readSync(descriptor, bytes, bytesRead, readBytes - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  let truncatedPrefixBytes = offset;
  let text = bytes.subarray(0, bytesRead).toString("utf8");
  if (offset > 0) {
    const newline = text.indexOf("\n");
    if (newline < 0) return { events: [], corruptLines: [], truncatedPrefixBytes: size };
    truncatedPrefixBytes += Buffer.byteLength(text.slice(0, newline + 1));
    text = text.slice(newline + 1);
  }
  const events: StructuredEvent[] = [];
  const corruptLines: Array<{ line: number; error: string }> = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isStructuredEvent(value)) throw new Error("invalid structured-event envelope");
      events.push(value);
    } catch (error) {
      const detail = {
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      };
      if (options.onCorrupt === "throw") {
        throw new Error(`corrupt observability log line ${detail.line}: ${detail.error}`);
      }
      corruptLines.push(detail);
    }
  }
  return { events, corruptLines, truncatedPrefixBytes };
}

function isStructuredEvent(value: unknown): value is StructuredEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === OBSERVABILITY_SCHEMA_VERSION
    && typeof candidate.id === "string"
    && Number.isSafeInteger(candidate.sequence)
    && typeof candidate.timestamp === "string"
    && typeof candidate.source === "string"
    && typeof candidate.type === "string"
    && candidate.data != null
    && typeof candidate.data === "object";
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
