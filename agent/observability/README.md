# Reliability / observability surface

`StructuredEventReporter` writes schema-versioned events. A sink failure is
counted in `diagnostics()` and never escapes `emit()`. `JsonlEventSink` writes
one event per line. Its default retention is finite: 16 MiB per file, four
files total (active plus three rotations), and 256 KiB per event. Oversize or
rotation failures stay inside the reporter failure boundary. `readEventLog()`
tail-reads at most 16 MiB by default, skips and reports torn/corrupt lines, and
returns `truncatedPrefixBytes` when older input was omitted. `MemoryEventSink`
is a 4,096-event ring by default and reports dropped events in diagnostics.

`ReliabilityMonitor` owns in-memory metrics for:

- named queue depth/current high-water
- correlated turn start/end latency and outcome
- process spawn attempts/failures and crashes
- Telegram attempts/failures/status/latency (retry-after stays in its event)
- RSS current/high-water

Hot paths should use `createSafeReliabilityHooks(monitor)`. Every hook contains
instrumentation errors, so recording cannot unwind delivery. The registry can
instead use `createObservedDaemonEventSink(monitor, existingSink)`, which keeps
the existing sink ordering and side effects. Active turns are closed as
`failed` on daemon crash/spawn failure so correlation state cannot leak across
terminal lifecycle events.

```ts
const reporter = new StructuredEventReporter({
  source: "poller",
  sink: new JsonlEventSink(eventLogPath),
});
const monitor = new ReliabilityMonitor({ reporter });
const hooks = createSafeReliabilityHooks(monitor);

hooks.recordQueueDepth("outbound", outbox.depth);
const turnId = hooks.startTurn(threadId);
hooks.finishTurn(threadId, turnId, "completed");
hooks.recordSpawn("claude-daemon", true, pid.toString());
hooks.recordCrash({ component: "claude-daemon", signal: "SIGKILL" });
hooks.recordTelegramRequest({
  operation: "sendMessage",
  ok: false,
  status: 429,
  retryAfterMs: 2_000,
});
```

`ReliabilityGate` defaults to `shadow`. It emits a `mode_selected` event and
the exact policy comparison on every evaluation. Shadow reports `wouldBlock`
but always allows. A window is not healthy until every configured metric has
minimum evidence (queue: 1 sample, turn latency: 20, Telegram: 20, RSS: 1 by
default). Missing evidence is emitted separately and never advances promotion.
After enough evidence-backed healthy windows report `promotionReady`, an
operator may consider `CTA_RELIABILITY_MODE=enforced`; enforced uses the same
comparisons and fails closed on either SLO violations or missing evidence.
Promotion is never automatic.

Fault injection is off by default. `FaultInjector` accepts explicit rules for
timeout, disk-full, kill checkpoints, and state corruption. Its kill callback
lets fault tests terminate a disposable child while unit tests use a safe throw.
