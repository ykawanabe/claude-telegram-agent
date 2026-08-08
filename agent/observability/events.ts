import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;

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
  readonly events: StructuredEvent[] = [];

  write(event: StructuredEvent): void {
    this.events.push(event);
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

  constructor(readonly path: string) {}

  write(event: StructuredEvent): void {
    // Lazy initialization keeps mkdir failures (including ENOSPC) inside the
    // reporter's non-throwing write boundary.
    if (!this.initialized) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.initialized = true;
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
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
}

/** Reads as much of an append-only log as is valid. A torn final write or a
 * corrupt line is reported separately so prior events remain useful. */
export function readEventLog(path: string, options: { onCorrupt?: "skip" | "throw" } = {}): ReadEventLogResult {
  const text = readFileSync(path, "utf8");
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
  return { events, corruptLines };
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
