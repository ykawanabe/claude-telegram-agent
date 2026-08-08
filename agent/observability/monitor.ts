import type { DaemonEvent, EventSink } from "../poller/contracts";
import { ReliabilityMetrics, type ReliabilityMetricsSnapshot } from "./metrics";
import { StructuredEventReporter } from "./events";

export interface ReliabilityMonitorOptions {
  reporter: StructuredEventReporter;
  metrics?: ReliabilityMetrics;
  now?: () => number;
  rssProvider?: () => number;
}

/** Hot-path surface for poller/transport/delivery integration. Implementations
 * returned by createSafeReliabilityHooks contain every instrumentation error. */
export interface ReliabilityHooks {
  recordQueueDepth(queue: string, depth: number, capacity?: number): void;
  startTurn(threadId: string, turnId?: string): string;
  finishTurn(
    threadId: string,
    turnId: string,
    outcome: "completed" | "timeout" | "failed" | "uncertain",
  ): void;
  recordSpawn(component: string, success: boolean, instanceId?: string): void;
  recordCrash(args: {
    component: string;
    count?: number;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  }): void;
  recordTelegramRequest(args: {
    operation: string;
    ok: boolean;
    status?: number;
    latencyMs?: number;
    retryAfterMs?: number;
  }): void;
  sampleRss(): void;
}

export class ReliabilityMonitor {
  readonly metrics: ReliabilityMetrics;
  private readonly now: () => number;
  private readonly rssProvider: () => number;
  private turnSequence = 0;

  constructor(private readonly options: ReliabilityMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.rssProvider = options.rssProvider ?? (() => process.memoryUsage().rss);
    this.metrics = options.metrics ?? new ReliabilityMetrics({ now: this.now });
  }

  recordQueueDepth(queue: string, depth: number, capacity?: number): void {
    this.metrics.recordQueueDepth(queue, depth);
    this.options.reporter.emit("queue.depth", { queue, depth, ...(capacity == null ? {} : { capacity }) });
  }

  startTurn(threadId: string, turnId = `${threadId}:${++this.turnSequence}`): string {
    this.metrics.startTurn(turnId, this.now());
    this.options.reporter.emit("turn.started", { turnId, threadId }, { threadId });
    return turnId;
  }

  finishTurn(
    threadId: string,
    turnId: string,
    outcome: "completed" | "timeout" | "failed" | "uncertain",
  ): void {
    const result = this.metrics.finishTurn(turnId, outcome, this.now());
    this.options.reporter.emit("turn.finished", {
      turnId,
      threadId,
      outcome,
      latencyMs: result.latencyMs,
      matchedStart: result.matchedStart,
    }, { threadId });
  }

  recordSpawn(component: string, success: boolean, instanceId?: string): void {
    this.metrics.recordSpawn(component, success);
    this.options.reporter.emit("process.spawn", {
      component,
      success,
      ...(instanceId ? { instanceId } : {}),
    });
  }

  recordCrash(args: {
    component: string;
    count?: number;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  }): void {
    const count = args.count ?? 1;
    this.metrics.recordCrash(args.component, count);
    this.options.reporter.emit("process.crash", {
      component: args.component,
      count,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.exitCode === undefined ? {} : { exitCode: args.exitCode }),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  }

  recordTelegramRequest(args: {
    operation: string;
    ok: boolean;
    status?: number;
    latencyMs?: number;
    retryAfterMs?: number;
  }): void {
    this.metrics.recordTelegramRequest(args);
    this.options.reporter.emit("telegram.request", args);
  }

  sampleRss(): number {
    const rssBytes = this.rssProvider();
    this.metrics.recordRss(rssBytes);
    this.options.reporter.emit("process.rss", { rssBytes });
    return rssBytes;
  }

  snapshot(): ReliabilityMetricsSnapshot {
    return this.metrics.snapshot(this.now());
  }

  /** Starts RSS and optional queue sampling. The returned stop function is
   * idempotent; unref keeps instrumentation from holding process shutdown. */
  startSampling(options: {
    intervalMs?: number;
    queueDepths?: () => Record<string, number>;
  } = {}): () => void {
    const intervalMs = options.intervalMs ?? 10_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("sampling interval must be positive");
    let stopped = false;
    const sample = () => {
      if (stopped) return;
      try {
        this.sampleRss();
      } catch (error) {
        this.reportSamplingError("rss", error);
      }
      if (options.queueDepths) {
        try {
          for (const [queue, depth] of Object.entries(options.queueDepths())) {
            this.recordQueueDepth(queue, depth);
          }
        } catch (error) {
          this.reportSamplingError("queue-depth", error);
        }
      }
    };
    sample();
    const timer = setInterval(sample, intervalMs);
    timer.unref?.();
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
  }

  private reportSamplingError(sampler: string, error: unknown): void {
    this.options.reporter.emit("observability.sampling_error", {
      sampler,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Converts the strict monitor API into a never-throwing integration surface.
 * Bad instrumentation input is dropped and may be reported out-of-band. */
export function createSafeReliabilityHooks(
  monitor: ReliabilityMonitor,
  onError?: (error: unknown) => void,
): ReliabilityHooks {
  let fallbackTurnSequence = 0;
  const attempt = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      try { onError?.(error); } catch { /* diagnostics stay contained */ }
    }
  };
  return {
    recordQueueDepth(queue, depth, capacity): void {
      attempt(() => monitor.recordQueueDepth(queue, depth, capacity));
    },
    startTurn(threadId, turnId): string {
      let correlatedId = turnId ?? `unobserved:${threadId}:${++fallbackTurnSequence}`;
      attempt(() => { correlatedId = monitor.startTurn(threadId, turnId); });
      return correlatedId;
    },
    finishTurn(threadId, turnId, outcome): void {
      attempt(() => monitor.finishTurn(threadId, turnId, outcome));
    },
    recordSpawn(component, success, instanceId): void {
      attempt(() => monitor.recordSpawn(component, success, instanceId));
    },
    recordCrash(args): void {
      attempt(() => monitor.recordCrash(args));
    },
    recordTelegramRequest(args): void {
      attempt(() => monitor.recordTelegramRequest(args));
    },
    sampleRss(): void {
      attempt(() => { monitor.sampleRss(); });
    },
  };
}

/** Adapts the registry's existing observation seam without changing its
 * behavior. The original sink still receives every event in the same call. */
export function createObservedDaemonEventSink(
  monitor: ReliabilityMonitor,
  downstream?: EventSink,
): EventSink {
  const activeTurns = new Map<string, string>();
  return {
    emit(event: DaemonEvent): void {
      try {
        switch (event.kind) {
          case "turn-start": {
            const stale = activeTurns.get(event.threadId);
            if (stale) monitor.finishTurn(event.threadId, stale, "uncertain");
            activeTurns.set(event.threadId, monitor.startTurn(event.threadId));
            break;
          }
          case "turn-end": {
            const turnId = activeTurns.get(event.threadId) ?? `unmatched:${event.threadId}`;
            activeTurns.delete(event.threadId);
            monitor.finishTurn(event.threadId, turnId, "completed");
            break;
          }
          case "spawn":
            monitor.recordSpawn("claude-daemon", true, event.threadId);
            break;
          case "crash":
            monitor.recordCrash({
              component: "claude-daemon",
              reason: `consecutive-crash-${event.crashCount}`,
              exitCode: event.code,
              signal: event.signal,
            });
            break;
          case "spawn-failed":
            monitor.recordSpawn("claude-daemon", false, event.threadId);
            break;
          case "crash-loop":
            // Each crash is recorded by the `crash` event. crash-loop is an
            // alert threshold, not another crash, so do not double-count it.
            break;
          default:
            break;
        }
      } catch {
        // Metrics must never break daemon delivery, including malformed hooks.
      }
      downstream?.emit(event);
    },
  };
}
