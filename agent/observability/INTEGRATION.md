# Wave 1 reliability / observability integration audit

Audit date: 2026-08-08 (Asia/Tokyo)
Branch: `codex/wave1-reliability-audit`
Scope: `agent/observability/**` and `tests/reliability/**`

No poller, channel, delivery, manifest, installer, or root script was changed in
this audit. Those paths were inspected read-only to verify the integration.

## Hooks and data flow

The existing central wiring is in `agent/poller/poller.ts`:

1. Lines 138-158 create `StructuredEventReporter`, `ReliabilityMonitor`, safe
   hooks, and a shadow-default `ReliabilityGate`. Events go to
   `$STATE_DIR/observability/events.jsonl`.
2. Lines 160-181 translate durable outbox attempt/terminal events into Telegram
   attempt, result, status, latency, and retry-after observations.
3. Lines 989-1018 wrap the daemon registry event sink. Turn start/end, daemon
   spawn/failure, and crash events feed the monitor while the original sink is
   still invoked. Crash/spawn-failure/crash-loop closes any active correlated
   turn as failed before later turns reuse that thread.
4. Lines 3123-3139 sample RSS and named queue depths. The inputs are daemon
   pending count, durable outbound depth, and the Telegram transport's inbound
   replayable/uncertain counts (`agent/channels/telegram/transport.ts:383`).
5. Line 3206 evaluates the cumulative snapshot during housekeeping. Line 3258
   stops the sampler during shutdown.

Public hot-path adapters are:

- `createSafeReliabilityHooks()`: queue depth, turn start/end, spawn, crash,
  Telegram result, and RSS. Instrumentation validation/sink errors never escape.
- `createObservedDaemonEventSink()`: records daemon lifecycle/turn events and
  then forwards the unchanged event to the existing sink.
- `ReliabilityMonitor.startSampling()`: synchronous first sample, then an
  unref'd periodic sampler; per-sampler failures become structured
  `observability.sampling_error` events.

Inputs are numeric gauges/counters and stable internal labels, never message
payloads or Telegram tokens. Outputs are an in-memory cumulative snapshot and
schema-versioned JSONL events with source, timestamp, boot-local sequence, ID,
and optional trace/message/thread context.

## Metrics and structured events

The current snapshot covers the requested Wave 1 signals:

- named queue current depth, high-water, and sample count;
- turn outcome and correlated latency (min/max/average/p50/p95/p99);
- process spawn attempts/failures and crash count by component;
- Telegram attempts/failures/failure rate/status and latency;
- RSS current/high-water/sample count.

Structured event types also include selected reliability mode, every policy
evaluation (violations plus evidence gaps), deterministic fault injection, and
sampling errors. Event sink failures are counted in reporter diagnostics and
contained, including ENOSPC, permission, rotation, and oversize-event failures.
Corrupt/torn log lines are reported without hiding other valid retained lines.

## Finite retention and work bounds

- JSONL defaults to 16 MiB per file and four files total (active + three
  rotations): at most about 64 MiB. Each event is capped at 256 KiB. Active and
  rotated files are forced to mode `0600`; the directory is created as `0700`.
- `readEventLog()` tail-reads at most 16 MiB by default and reports omitted
  prefix bytes. It does not load an arbitrarily large external file.
- `MemoryEventSink` is a 4,096-event ordered ring and exposes a dropped count.
- Turn and Telegram percentile reservoirs retain 2,048 samples each while
  lifetime count/min/max/average remain cumulative.
- Unfinished turn correlation is capped at 4,096 entries. Further starts fail
  only inside the safe instrumentation boundary until capacity is released.
- The load/soak harness uses bounded concurrency and a 4,096-sample latency
  reservoir by default. Load is operation-bounded; soak is duration-bounded.
- Fault rules are explicit and consumption-counted. Delivery retry is outside
  this ownership area; read-only audit found eight maximum outbound attempts
  and a five-minute backoff cap.

Cardinality depends on callers using the documented stable queue/component
labels. The production wiring does so. Arbitrary dynamic labels are not a
supported input contract.

## Fault semantics

`FaultInjector` is disabled without an explicit rule plan. It deterministically
covers:

- timeout: rejects with `ETIMEDOUT` before the operation runs;
- disk full: rejects with `ENOSPC` before the operation runs;
- process kill: calls the supplied kill hook, then uses a safe injected error if
  the hook returns; the suite also proves real `SIGKILL` against a disposable
  child process;
- corrupt state: truncate, flip-byte, or invalid-JSON transformation.

The generic `CTA_FAULT_PLAN` injector is a test/harness seam today; it is not
constructed by the poller. Delivery modules also expose their own checkpoint
seams and their fault tests cover crash recovery, ENOSPC, and corrupt records.
No production process is killed merely by setting the generic plan in the
current central wiring.

## Shadow measurement and Gate

The Gate remains shadow by default. Shadow records the exact decision but never
blocks. This audit added minimum evidence so an empty or undersampled snapshot
cannot advance the consecutive-healthy counter or report promotion readiness:

| Configured SLO | Default minimum evidence |
| --- | ---: |
| Queue depth | 1 queue sample |
| Turn p95 | 20 completed-turn latency samples |
| Telegram failure rate | 20 attempts (or `minTelegramSamples`) |
| RSS | 1 RSS sample |

The poller currently configures queue depth <= 1,000, turn p95 <= 600,000 ms,
Telegram failure rate <= 0.25 after 20 attempts, and RSS <= 2 GiB. Promotion
also requires 12 consecutive evidence-backed healthy evaluations. Enforced
`assertHealthy()` fails closed on either SLO violations or missing evidence.
There is no automatic shadow-to-enforced switch.

Real local shadow evidence at audit time was **zero**: the poller was stopped,
`~/.pager/.env` was absent, and neither the observability event log nor delivery
state existed. Therefore there is no evidence for enforced mode and no rollout
promotion was made.

Synthetic harness evidence is useful only as harness validation, not a rollout
decision. The 1-second run (`concurrency=8`, target 200 ops/s, 2 ms synthetic
latency) completed 200 operations with 0 failures, p95 2.323 ms, about 5.44 MiB
RSS growth, and a passing verdict.

## Failure semantics

- Metrics/reporting are observational: invalid inputs and sink failures are
  contained by safe hooks and must not unwind delivery.
- A malformed reliability mode or invalid threshold/minimum is rejected during
  configuration/evaluation instead of silently selecting a policy.
- Shadow violations and missing evidence set `wouldBlock=true` but
  `allowed=true`. Enforced `assertHealthy()` throws `ReliabilityPolicyError`.
- JSONL rotation/read failures are surfaced through reporter diagnostics; they
  do not alter the delivery result.

## Changed files and verification

Changed implementation/docs:

- `agent/observability/events.ts`
- `agent/observability/metrics.ts`
- `agent/observability/monitor.ts`
- `agent/observability/reliability-gate.ts`
- `agent/observability/README.md`
- `agent/observability/INTEGRATION.md`

Changed/added tests:

- `tests/reliability/events.test.ts`
- `tests/reliability/metrics.test.ts`
- `tests/reliability/monitor.test.ts`
- `tests/reliability/reliability-gate.test.ts`
- `tests/reliability/fault-injection.test.ts`
- `tests/reliability/fixtures/fault-kill-child.ts`
- `tests/reliability/README.md`

Verification results:

- `bun test tests/reliability`: 31 passed, 0 failed.
- `bash tests/test_delivery_reliability.sh`: 64 passed, 0 failed.
- `bun test agent/poller/poller.test.ts agent/poller/claude-daemon-registry.test.ts
  agent/channels/telegram/transport.test.ts`: 108 passed, 0 failed.
- `bun tests/reliability/load-harness.ts --duration-ms 1000 --concurrency 8
  --rate 200 --latency-ms 2 --max-failure-rate 0.01`: passed, 200 operations,
  0 failures.
- `git diff --check`: passed.

## Remaining risks / incomplete work

1. **No real shadow traffic exists.** Enforced rollout is not justified.
2. **The central poller calls `evaluate()` and discards the decision.** It is
   telemetry-only even if `CTA_RELIABILITY_MODE=enforced`; no operation is
   guarded with `assertHealthy()`. Central wiring is intentionally unchanged in
   this audit and must remain shadow until a separately reviewed enforcement
   point exists.
3. **"Windows" are cumulative snapshots, not independent time buckets.** Once
   minimum evidence exists, repeated housekeeping evaluations can reuse much of
   the same lifetime data. Production-duration shadow collection and a
   windowed/persisted promotion report are still required before enforcement.
4. **The integrated Wave 1 path is bounded, but its count/retention trade-offs
   remain operational constraints.** The inbound journal now caps records at
   10,000 and active/recovery work at 1,000; the outbox caps pending/list and
   terminal buckets; the daemon registry caps topics, queued entries, per-entry
   characters, spawn attempts, and release lifetime. Count plus per-entry limits
   imply a finite aggregate daemon queue. Completed delivery tombstones are
   evicted within those bounds, so deduplication is not permanent.
5. **The generic environment fault plan is not wired into production
   checkpoints.** Current coverage is deterministic tests plus delivery-local
   seams, not a live chaos switch.
6. The integration run extended the synthetic soak to 30 seconds (3,024
   operations, zero failures), but this still does not establish production
   duration RSS stability, real Telegram error rate, or macOS launchd behavior.
   A staged multi-hour shadow observation remains a promotion prerequisite, not
   evidence supplied by this audit.
