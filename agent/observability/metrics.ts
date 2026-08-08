export interface DistributionSnapshot {
  count: number;
  minMs: number;
  maxMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface QueueDepthSnapshot {
  current: number;
  max: number;
  samples: number;
}

export interface ReliabilityMetricsSnapshot {
  capturedAt: string;
  queues: Record<string, QueueDepthSnapshot>;
  turns: {
    started: number;
    finished: number;
    inFlight: number;
    unmatchedFinishes: number;
    outcomes: Record<"completed" | "timeout" | "failed" | "uncertain", number>;
    latency: DistributionSnapshot;
  };
  processes: {
    spawnAttempts: number;
    spawnFailures: number;
    crashes: number;
    byComponent: Record<string, { spawnAttempts: number; spawnFailures: number; crashes: number }>;
  };
  telegram: {
    attempts: number;
    failures: number;
    failureRate: number;
    byStatus: Record<string, number>;
    latency: DistributionSnapshot;
  };
  rss: {
    currentBytes: number;
    maxBytes: number;
    samples: number;
  };
}

type TurnOutcome = keyof ReliabilityMetricsSnapshot["turns"]["outcomes"];

class BoundedDistribution {
  private readonly samples: number[] = [];
  private nextIndex = 0;
  private count = 0;
  private total = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = 0;

  constructor(private readonly capacity: number) {}

  add(value: number): void {
    assertNonNegativeFinite("distribution value", value);
    this.count += 1;
    this.total += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    if (this.samples.length < this.capacity) {
      this.samples.push(value);
      return;
    }
    this.samples[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
  }

  snapshot(): DistributionSnapshot {
    if (this.count === 0) {
      return { count: 0, minMs: 0, maxMs: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      count: this.count,
      minMs: this.min,
      maxMs: this.max,
      averageMs: this.total / this.count,
      p50Ms: percentile(sorted, 0.50),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
    };
  }
}

interface ProcessCounters {
  spawnAttempts: number;
  spawnFailures: number;
  crashes: number;
}

export class ReliabilityMetrics {
  private readonly queues = new Map<string, QueueDepthSnapshot>();
  private readonly turnStarts = new Map<string, number>();
  private readonly turnLatency: BoundedDistribution;
  private readonly telegramLatency: BoundedDistribution;
  private turnStartedCount = 0;
  private turnFinishedCount = 0;
  private unmatchedFinishes = 0;
  private readonly outcomes: Record<TurnOutcome, number> = {
    completed: 0,
    timeout: 0,
    failed: 0,
    uncertain: 0,
  };
  private readonly processes = new Map<string, ProcessCounters>();
  private telegramAttempts = 0;
  private telegramFailures = 0;
  private readonly telegramByStatus = new Map<string, number>();
  private rssCurrent = 0;
  private rssMax = 0;
  private rssSamples = 0;

  constructor(private readonly options: { maxDistributionSamples?: number; now?: () => number } = {}) {
    const capacity = options.maxDistributionSamples ?? 2_048;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("maxDistributionSamples must be a positive integer");
    this.turnLatency = new BoundedDistribution(capacity);
    this.telegramLatency = new BoundedDistribution(capacity);
  }

  recordQueueDepth(queue: string, depth: number): void {
    if (!queue) throw new Error("queue name must not be empty");
    assertNonNegativeInteger("queue depth", depth);
    const previous = this.queues.get(queue);
    this.queues.set(queue, {
      current: depth,
      max: Math.max(previous?.max ?? 0, depth),
      samples: (previous?.samples ?? 0) + 1,
    });
  }

  startTurn(turnId: string, startedAtMs = this.now()): void {
    if (!turnId) throw new Error("turnId must not be empty");
    if (this.turnStarts.has(turnId)) throw new Error(`turn already started: ${turnId}`);
    assertNonNegativeFinite("turn start", startedAtMs);
    this.turnStarts.set(turnId, startedAtMs);
    this.turnStartedCount += 1;
  }

  finishTurn(
    turnId: string,
    outcome: TurnOutcome,
    finishedAtMs = this.now(),
  ): { latencyMs: number; matchedStart: boolean } {
    assertNonNegativeFinite("turn finish", finishedAtMs);
    const startedAt = this.turnStarts.get(turnId);
    const matchedStart = startedAt != null;
    const latencyMs = matchedStart ? Math.max(0, finishedAtMs - startedAt) : 0;
    if (matchedStart) {
      this.turnStarts.delete(turnId);
      this.turnLatency.add(latencyMs);
    } else {
      this.unmatchedFinishes += 1;
    }
    this.turnFinishedCount += 1;
    this.outcomes[outcome] += 1;
    return { latencyMs, matchedStart };
  }

  recordSpawn(component: string, success: boolean): void {
    const counters = this.processCounter(component);
    counters.spawnAttempts += 1;
    if (!success) counters.spawnFailures += 1;
  }

  recordCrash(component: string, count = 1): void {
    assertNonNegativeInteger("crash count", count);
    this.processCounter(component).crashes += count;
  }

  recordTelegramRequest(args: { ok: boolean; status?: number; latencyMs?: number }): void {
    this.telegramAttempts += 1;
    if (!args.ok) this.telegramFailures += 1;
    const statusKey = args.status == null ? (args.ok ? "ok" : "network") : String(args.status);
    this.telegramByStatus.set(statusKey, (this.telegramByStatus.get(statusKey) ?? 0) + 1);
    if (args.latencyMs != null) this.telegramLatency.add(args.latencyMs);
  }

  recordRss(rssBytes: number): void {
    assertNonNegativeInteger("RSS", rssBytes);
    this.rssCurrent = rssBytes;
    this.rssMax = Math.max(this.rssMax, rssBytes);
    this.rssSamples += 1;
  }

  snapshot(capturedAtMs = this.now()): ReliabilityMetricsSnapshot {
    const queues: Record<string, QueueDepthSnapshot> = {};
    for (const [name, value] of [...this.queues].sort(([a], [b]) => a.localeCompare(b))) {
      queues[name] = { ...value };
    }

    const byComponent: ReliabilityMetricsSnapshot["processes"]["byComponent"] = {};
    let spawnAttempts = 0;
    let spawnFailures = 0;
    let crashes = 0;
    for (const [component, counters] of [...this.processes].sort(([a], [b]) => a.localeCompare(b))) {
      byComponent[component] = { ...counters };
      spawnAttempts += counters.spawnAttempts;
      spawnFailures += counters.spawnFailures;
      crashes += counters.crashes;
    }

    const byStatus: Record<string, number> = {};
    for (const [status, count] of [...this.telegramByStatus].sort(([a], [b]) => a.localeCompare(b))) {
      byStatus[status] = count;
    }

    return {
      capturedAt: new Date(capturedAtMs).toISOString(),
      queues,
      turns: {
        started: this.turnStartedCount,
        finished: this.turnFinishedCount,
        inFlight: this.turnStarts.size,
        unmatchedFinishes: this.unmatchedFinishes,
        outcomes: { ...this.outcomes },
        latency: this.turnLatency.snapshot(),
      },
      processes: { spawnAttempts, spawnFailures, crashes, byComponent },
      telegram: {
        attempts: this.telegramAttempts,
        failures: this.telegramFailures,
        failureRate: this.telegramAttempts === 0 ? 0 : this.telegramFailures / this.telegramAttempts,
        byStatus,
        latency: this.telegramLatency.snapshot(),
      },
      rss: {
        currentBytes: this.rssCurrent,
        maxBytes: this.rssMax,
        samples: this.rssSamples,
      },
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private processCounter(component: string): ProcessCounters {
    if (!component) throw new Error("component must not be empty");
    let counters = this.processes.get(component);
    if (!counters) {
      counters = { spawnAttempts: 0, spawnFailures: 0, crashes: 0 };
      this.processes.set(component, counters);
    }
    return counters;
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertNonNegativeFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
}
