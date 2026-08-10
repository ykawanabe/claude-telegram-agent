import type { ReliabilityHooks } from "../../agent/observability";

export interface LoadThresholds {
  maxFailureRate?: number;
  maxP95Ms?: number;
  maxRssGrowthBytes?: number;
}

export interface LoadSummary {
  kind: "load" | "soak";
  operations: number;
  failures: number;
  failureRate: number;
  elapsedMs: number;
  throughputPerSec: number;
  latency: {
    minMs: number;
    maxMs: number;
    averageMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  rss: {
    startBytes: number;
    endBytes: number;
    peakBytes: number;
    growthBytes: number;
  };
  passed: boolean;
  violations: string[];
}

export interface LoadScenarioOptions {
  operations: number;
  concurrency: number;
  operation: (index: number) => unknown | Promise<unknown>;
  thresholds?: LoadThresholds;
  hooks?: ReliabilityHooks;
  rssProvider?: () => number;
  maxLatencySamples?: number;
}

export interface SoakScenarioOptions {
  durationMs: number;
  concurrency: number;
  operation: (index: number) => unknown | Promise<unknown>;
  targetOperationsPerSec?: number;
  thresholds?: LoadThresholds;
  hooks?: ReliabilityHooks;
  rssProvider?: () => number;
  maxLatencySamples?: number;
}

interface Accumulator {
  operations: number;
  failures: number;
  latencyTotal: number;
  latencyMin: number;
  latencyMax: number;
  latencySamples: number[];
  nextSample: number;
  peakRss: number;
}

/** Finite, bounded-concurrency load runner. It retains only a bounded latency
 * reservoir so a long soak does not become the memory leak being measured. */
export async function runLoadScenario(options: LoadScenarioOptions): Promise<LoadSummary> {
  assertPositiveInteger("operations", options.operations);
  assertPositiveInteger("concurrency", options.concurrency);
  const next = { value: 0 };
  return runWorkers(
    "load",
    options.concurrency,
    options.operation,
    () => next.value < options.operations ? next.value++ : null,
    options,
    options.operations,
  );
}

/** Time-bounded runner for leak/crash detection. Optional target rate is
 * divided across workers; omitted means maximum sustainable throughput. */
export async function runSoakScenario(options: SoakScenarioOptions): Promise<LoadSummary> {
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) throw new Error("durationMs must be positive");
  assertPositiveInteger("concurrency", options.concurrency);
  if (options.targetOperationsPerSec != null && (!Number.isFinite(options.targetOperationsPerSec) || options.targetOperationsPerSec <= 0)) {
    throw new Error("targetOperationsPerSec must be positive");
  }
  const deadline = performance.now() + options.durationMs;
  const next = { value: 0 };
  const paceMs = options.targetOperationsPerSec == null
    ? 0
    : (1_000 * options.concurrency) / options.targetOperationsPerSec;
  return runWorkers(
    "soak",
    options.concurrency,
    options.operation,
    () => performance.now() < deadline ? next.value++ : null,
    options,
    0,
    { paceMs, deadline },
  );
}

async function runWorkers(
  kind: "load" | "soak",
  concurrency: number,
  operation: (index: number) => unknown | Promise<unknown>,
  takeIndex: () => number | null,
  options: {
    thresholds?: LoadThresholds;
    hooks?: ReliabilityHooks;
    rssProvider?: () => number;
    maxLatencySamples?: number;
  },
  initialQueueDepth = 0,
  pacing?: { paceMs: number; deadline: number },
): Promise<LoadSummary> {
  const rssProvider = options.rssProvider ?? (() => process.memoryUsage().rss);
  const startRss = safeRss(rssProvider);
  const accumulator: Accumulator = {
    operations: 0,
    failures: 0,
    latencyTotal: 0,
    latencyMin: Number.POSITIVE_INFINITY,
    latencyMax: 0,
    latencySamples: [],
    nextSample: 0,
    peakRss: startRss,
  };
  const maxLatencySamples = options.maxLatencySamples ?? 4_096;
  assertPositiveInteger("maxLatencySamples", maxLatencySamples);
  const startedAt = performance.now();
  let claimed = 0;
  options.hooks?.recordQueueDepth("load.pending", initialQueueDepth);

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = takeIndex();
      if (index == null) return;
      claimed += 1;
      options.hooks?.recordQueueDepth("load.pending", Math.max(0, initialQueueDepth - claimed));
      const operationStarted = performance.now();
      try {
        await operation(index);
      } catch {
        accumulator.failures += 1;
      }
      const latency = performance.now() - operationStarted;
      accumulator.operations += 1;
      accumulator.latencyTotal += latency;
      accumulator.latencyMin = Math.min(accumulator.latencyMin, latency);
      accumulator.latencyMax = Math.max(accumulator.latencyMax, latency);
      addBoundedSample(accumulator, latency, maxLatencySamples);
      if (accumulator.operations === 1 || accumulator.operations % 100 === 0) {
        const rss = safeRss(rssProvider);
        accumulator.peakRss = Math.max(accumulator.peakRss, rss);
        options.hooks?.sampleRss();
      }
      if (pacing && pacing.paceMs > 0) {
        const remainingPace = pacing.paceMs - (performance.now() - operationStarted);
        const remainingScenario = pacing.deadline - performance.now();
        const sleepMs = Math.min(remainingPace, remainingScenario);
        if (sleepMs > 0) await Bun.sleep(sleepMs);
      }
    }
  }));

  const elapsedMs = performance.now() - startedAt;
  const endRss = safeRss(rssProvider);
  accumulator.peakRss = Math.max(accumulator.peakRss, endRss);
  return summarize(kind, accumulator, startRss, endRss, elapsedMs, options.thresholds ?? {});
}

function addBoundedSample(accumulator: Accumulator, value: number, capacity: number): void {
  if (accumulator.latencySamples.length < capacity) {
    accumulator.latencySamples.push(value);
    return;
  }
  accumulator.latencySamples[accumulator.nextSample] = value;
  accumulator.nextSample = (accumulator.nextSample + 1) % capacity;
}

function summarize(
  kind: "load" | "soak",
  accumulator: Accumulator,
  startRss: number,
  endRss: number,
  elapsedMs: number,
  thresholds: LoadThresholds,
): LoadSummary {
  const sorted = [...accumulator.latencySamples].sort((a, b) => a - b);
  const operations = accumulator.operations;
  const failureRate = operations === 0 ? 0 : accumulator.failures / operations;
  const p95Ms = percentile(sorted, 0.95);
  const growthBytes = endRss - startRss;
  const violations: string[] = [];
  if (thresholds.maxFailureRate != null && failureRate > thresholds.maxFailureRate) {
    violations.push(`failure-rate ${failureRate} > ${thresholds.maxFailureRate}`);
  }
  if (thresholds.maxP95Ms != null && p95Ms > thresholds.maxP95Ms) {
    violations.push(`p95-ms ${p95Ms} > ${thresholds.maxP95Ms}`);
  }
  if (thresholds.maxRssGrowthBytes != null && growthBytes > thresholds.maxRssGrowthBytes) {
    violations.push(`rss-growth ${growthBytes} > ${thresholds.maxRssGrowthBytes}`);
  }
  return {
    kind,
    operations,
    failures: accumulator.failures,
    failureRate,
    elapsedMs,
    throughputPerSec: elapsedMs === 0 ? 0 : operations * 1_000 / elapsedMs,
    latency: {
      minMs: operations === 0 ? 0 : accumulator.latencyMin,
      maxMs: accumulator.latencyMax,
      averageMs: operations === 0 ? 0 : accumulator.latencyTotal / operations,
      p50Ms: percentile(sorted, 0.50),
      p95Ms,
      p99Ms: percentile(sorted, 0.99),
    },
    rss: {
      startBytes: startRss,
      endBytes: endRss,
      peakBytes: accumulator.peakRss,
      growthBytes,
    },
    passed: violations.length === 0,
    violations,
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function safeRss(provider: () => number): number {
  try {
    const value = provider();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (let index = 2; index < Bun.argv.length; index += 2) {
    args.set(Bun.argv[index], Bun.argv[index + 1]);
  }
  const durationMs = Number(args.get("--duration-ms") ?? "30000");
  const concurrency = Number(args.get("--concurrency") ?? "16");
  const rate = Number(args.get("--rate") ?? "100");
  const syntheticLatencyMs = Number(args.get("--latency-ms") ?? "2");
  const failureEvery = Number(args.get("--failure-every") ?? "0");
  const maxFailureRate = Number(args.get("--max-failure-rate") ?? "0.01");
  const summary = await runSoakScenario({
    durationMs,
    concurrency,
    targetOperationsPerSec: rate,
    operation: async (index) => {
      await Bun.sleep(syntheticLatencyMs);
      if (failureEvery > 0 && index > 0 && index % failureEvery === 0) throw new Error("synthetic failure");
    },
    thresholds: { maxFailureRate },
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.passed) process.exitCode = 1;
}
