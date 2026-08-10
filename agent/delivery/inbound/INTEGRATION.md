# Inbound journal integration contract

## Hook and ordering

The transport must use a stable upstream message ID (Telegram `update_id`) and
preserve this ordering:

1. `receive({ messageId, payload })` persists `received` before advancing the
   upstream cursor.
2. Only an admission with `action: "process"` and `managed: true` may call
   `claim(messageId, owner)`.
3. Normalize or otherwise validate while the record is `claimed`. A known
   pre-dispatch rejection calls `markLost`; a retryable pre-dispatch failure
   calls `releaseClaim`.
4. `markDispatched(messageId, token)` must be durable immediately before the
   first operation that can make the input externally visible.
5. `complete(messageId, token)` is allowed only after a positive, durable
   downstream acknowledgement. Any result that cannot be proved after step 4
   calls `markOutcomeUnknown` and must not be automatically replayed.
6. Singleton startup calls `recoverAfterCrash()` before polling. It dispatches
   every returned `replayable` entry and holds every `uncertain` entry.

The central integration now carries an explicit daemon receipt through
`agent/poller/poller.ts` and `agent/channels/telegram/transport.ts`. A managed
journal record remains `dispatched` while the receipt is pending. It becomes
`completed` only after the correlated daemon turn ends successfully; a send
failure, crash, reset, shutdown, or process death instead leaves or marks the
record `uncertain`, which is never automatically replayed. The Telegram poll
loop does not wait for the receipt, so one long daemon turn does not block later
updates.

In shadow mode, the legacy inbox copy is removed as soon as the daemon queue
accepts the tracked receipt. This keeps legacy processing non-blocking without
retaining a second replay source during the turn. Recovery/duplicate shadow
dispatches attach a rejection consumer so a later daemon failure cannot become
an unhandled promise rejection.

## Inputs and outputs

- Input: `InboundEnvelope<Payload>` with a non-empty, stable `messageId` of at
  most 1024 characters and a JSON-serializable payload.
- Admission output: `action` is `process`, `suppress`, or `hold`; `wouldEnforce`
  also includes `fail-closed`; `managed` tells the caller whether lifecycle
  methods may be used for that observation.
- Recovery output: `replayable`, `uncertain`, durable `losses`, and transition
  counters. The active set and one-shot recovery buffer are bounded by
  `maxReplayBatch`.
- Storage: `records/`, `quarantine/`, and `.journal.lock` under `rootDir`.

Default limits are 1 MiB per journal JSON file, 10,000 retained records, 1,000
active/recovery records, and 256 quarantined corrupt records. Constructor
options `maxRecordBytes`, `maxRecords`, `maxReplayBatch`, and
`maxQuarantineRecords` can lower or raise them; `maxReplayBatch` must not exceed
`maxRecords`.

## Failure semantics and capacity

- `duplicate`: a retained message ID is suppressed in enforced mode and only
  observed in shadow mode.
- `loss`: known pre-dispatch abandonment, corruption, unreadable state, journal
  I/O failure, and capacity exhaustion. Shadow `receive()` returns an observable
  `journal-error` and allows the legacy path; enforced mode throws
  `InboundDeliveryError` before unjournaled processing.
- `outcome-unknown`: dispatch crossed the side-effect boundary but completion
  is not provable. Enforced mode holds it and never automatically duplicates it.

`maxRecords` is enforced without growing a second unbounded queue. At total
capacity, the oldest `completed` tombstone is deleted to admit new work.
Consequently, deduplication is guaranteed only while a completed tombstone is
retained. This is an explicit bounded-retention tradeoff: an upstream source
that can replay arbitrarily old IDs must provide its own cursor/idempotency
window or configure a larger capacity. Active and uncertain records are never
evicted. If capacity has no completed tombstone to evict, enforced mode fails
closed and shadow mode falls back observably.

Quarantine evidence is never silently evicted. At
`maxQuarantineRecords`, the next corrupt record remains in `records/`; enforced
mode fails closed and shadow admission uses the observable fallback. JSON reads
are size-checked before allocating the read buffer. Temp files are mode `0600`,
file-fsynced, atomically renamed, then parent-directory-fsynced; startup removes
orphan temp files left by a kill.

## Summary and metrics

`summary()` exposes:

- per-state counts and `storedRecords` / `activeRecords`;
- configured record, replay, quarantine, and byte capacities;
- duplicate observations and shadow would-suppress/would-hold counters;
- known loss, unknown outcome, and corrupt record counts.

The first call (normally `recoverAfterCrash()` at startup) builds a bounded
in-memory index. Journal-owned transitions update it incrementally, so periodic
`deliveryQueueDepths() -> summary()` sampling does not synchronously read every
record. A fresh process or explicit recovery rebuild reconciles disk state.
The production contract remains a singleton journal owner; external mutation
or a second long-lived writer can make the in-memory summary stale until that
reconciliation, though durable record operations remain lock-serialized.

Recommended central metric wiring:

- `states.received + states.claimed` -> `inbound.replayable` queue depth;
- `states.uncertain` -> `inbound.uncertain` queue depth;
- `knownLosses`, `unknownOutcomes`, `duplicateObservations` -> reliability
  counters/alerts;
- `activeRecords / maxReplayBatch`, `storedRecords / maxRecords`, and
  `quarantineRecords / maxQuarantineRecords` -> capacity saturation gauges.

## Feature flag and fallback

`CTA_INBOUND_JOURNAL_MODE` defaults to `shadow`; only `shadow` and `enforced`
are accepted. Shadow records comparisons but preserves the legacy processing
path for duplicates, unknown outcomes, and journal/capacity errors. Enforced
makes suppress/hold/fail-closed authoritative. Promotion must therefore happen
only after journal-error, loss, uncertainty, and capacity metrics are healthy.

## Changed files and tests

- `journal.ts`: bounded storage/buffers, incremental summary index, orphan-temp
  cleanup, live-lock ownership fix.
- `types.ts`: capacity and storage fields in `InboundJournalSummary`.
- `journal.test.ts`: state, dedupe, capacity, retention, byte bound, summary.
- `journal.fault.test.ts`: disk-full/corruption, real SIGKILL recovery, lock
  timeout/live ownership, `0600`, quarantine capacity.
- `journal.kill-fixture.ts`: child process killed at a post-fsync fault point.
- `INTEGRATION.md`: this integration and failure-semantics contract.

Verification result at authoring time:

```text
bun test agent/delivery/inbound
23 pass, 0 fail, 103 assertions

bun test agent/delivery tests/reliability agent/channels/telegram/transport.test.ts
92 pass, 0 fail, 304 assertions
```

## Remaining risks

- A pair/chat switch deliberately cancels old-chat queued work and settles its
  journal outcome as uncertain; it is not replayed into the new chat because
  topic IDs and reply addresses can collide across chats. The user must resend.
- Completed tombstone eviction intentionally shortens the dedupe window.
- Quarantine saturation requires operator cleanup or a capacity increase; it
  deliberately does not discard loss evidence.
- Existing installations already beyond a configured bound fail closed during
  recovery and require an operator-selected larger limit or offline cleanup.
