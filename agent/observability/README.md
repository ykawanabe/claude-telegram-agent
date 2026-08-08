# Reliability / observability surface

`StructuredEventReporter` writes schema-versioned events. A sink failure is
counted in `diagnostics()` and never escapes `emit()`. `JsonlEventSink` writes
one event per line; `readEventLog()` skips and reports torn/corrupt lines while
retaining valid history.

`ReliabilityMonitor` owns in-memory metrics for:

- named queue depth/current high-water
- correlated turn start/end latency and outcome
- process spawn attempts/failures and crashes
- Telegram attempts/failures/status/latency/retry-after
- RSS current/high-water

Hot paths should use `createSafeReliabilityHooks(monitor)`. Every hook contains
instrumentation errors, so recording cannot unwind delivery. The registry can
instead use `createObservedDaemonEventSink(monitor, existingSink)`, which keeps
the existing sink ordering and side effects.

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
but always allows. After enough consecutive healthy windows report
`promotionReady`, set `CTA_RELIABILITY_MODE=enforced`; enforced uses the same
comparisons and rejects unhealthy gates.

Fault injection is off by default. `FaultInjector` accepts explicit rules for
timeout, disk-full, kill checkpoints, and state corruption. Its kill callback
lets fault tests terminate a disposable child while unit tests use a safe throw.
