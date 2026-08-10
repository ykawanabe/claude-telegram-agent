# Wave 1 outbound outbox integration

## Status and hook

`PersistentOutbox` is the durable policy layer. Production constructs it in
`agent/channels/transport-factory.ts` through `makeOutboundQueue()` and starts
recovery/polling immediately. The default store root is
`<stateDir>/delivery/outbound`.

The Telegram wire path is intentionally two seams, not two queues:

1. `makeOutboundQueue()` adapts `ChatTransport.sendText/sendButtons` to
   `OutboundSender` and owns persistence, deduplication, and retry policy.
2. `TelegramTransport` owns one private `TelegramOutboundSender`, which performs
   the Bot API request and throws classified `OutboundSendError` values back to
   the outer outbox.

`agent/poller/poller.ts` creates the queue once, uses it for normal replies,
mount-choice buttons, and daemon output, samples its depth, and awaits `stop()`
on shutdown. `CTA_OUTBOX_MODE` selects `shadow` or `enforced`; absent or empty
configuration is `shadow`.

## Inputs and outputs

Input is `OutboundMessage` from `agent/channels/types.ts`:

- text: `{ kind: "text", to, text, deliveryKey? }`
- buttons: `{ kind: "buttons", to, text, buttons, deliveryKey? }`
- each button may be a string or `{ label, action }`

`PersistentOutbox.enqueue()` optionally accepts a caller ID or a deduplication
key. It returns `DeliveryResult` with the durable outbox ID, attempt count,
status, failure details, retry time, and the platform's real `MessageRef` when
confirmed. Telegram success requires a positive integer `message_id`; the
outbox never manufactures a placeholder ID.

The store uses file-per-record buckets:

- `pending/`: queued, sending, retry-wait, and uncertain records
- `completed/`: confirmed delivery and its real `MessageRef`
- `dead-letter/`: permanent or retry-exhausted failures
- `corrupt/`: bounded invalid-record diagnostics and reason companions

## Durability and finite-resource limits

The first `queued` record is durable before any network call. Each attempt
persists `sending` before entering the sender. Files are created as `0600` via a
same-directory temporary file, file `fsync`, `rename`, and directory `fsync`.
Terminal copies win over stale pending copies after a crash. Startup removes
orphan `.tmp` files.

Default `FileOutboxStore` limits are:

- 1 MiB per JSON record
- 10,000 pending records
- 10,000 records materialized by a list call
- 10,000 completed records retained
- 10,000 dead letters retained
- 1,000 corrupt records retained

Pending and uncertain work is never pruned. A full pending queue or oversized
new record fails before the sender is called. Before adding a new terminal
record, the oldest record in that terminal bucket is pruned to reserve space.
Recovery uses a bounded min-heap, so scanning legacy over-retention directories
does not allocate an array proportional to their size. Oversized corrupt input
is discarded rather than copied into the diagnostic bucket; its bounded reason
record remains.

`TelegramOutboundSender` caps response bodies at 64 KiB and keeps the default
15-second timeout active through both header fetch and body consumption. The
same abort signal cancels a blocked body reader. Its concrete `send()` also
accepts an optional caller `AbortSignal`.

Retries are finite: default maximum 8 attempts. Enforced 429 and HTTP/API 5xx
use equal-jitter exponential backoff from 1 second to 5 minutes. Telegram
`retry_after` (body first, then header) is a minimum delay. Numeric conversion
rejects non-finite or unsafe millisecond values.

## Failure semantics

| Condition | Durable result | Automatic replay |
| --- | --- | --- |
| Confirmed Telegram success with valid `message_id` | `delivered` in `completed/` | No |
| Telegram 429 or HTTP/API 5xx, attempts remain | `retry_wait` with `nextAttemptAt` | Enforced mode only |
| Permanent Telegram rejection or exhausted retries | `dead_letter` | No |
| Timeout, reset, caller cancellation after request start, unreadable 2xx, or missing/invalid success `message_id` | `uncertain` | No; duplicate outcome cannot be excluded |
| Process death while durable state is `sending` | Recovered to `uncertain` | No |
| Corrupt pending JSON/schema | Moved to bounded `corrupt/`; healthy records continue | No |
| Initial ENOSPC/permission/capacity failure | Enqueue throws before network I/O | No |
| Failure while persisting a post-send result | Durable `sending` remains and recovers as `uncertain` if the failure cannot be journaled | No |

Shadow mode still journals and makes one real attempt. It records the enforced
decision in `shadowComparison` but never performs an outbox retry. The central
shadow adapter deliberately falls back to one direct legacy send when initial
outbox persistence itself fails; enforced mode fails closed instead.

## Events and metrics

The outbox emits non-throwing events for enqueue, attempt start, delivery,
retry scheduling, dead-letter, uncertain outcome, shadow comparison, and
in-flight recovery. Events include mode, attempt, state, failure kind, HTTP
status, retry-after, next attempt, and confirmed `MessageRef` where applicable.

`agent/poller/poller.ts:observeOutboxEvent()` correlates attempt start with the
terminal attempt event and records `telegram.request` success/failure, status,
latency, and retry-after. Reliability sampling reports
`outbound.pending = outboundQueue.depth()`. Event-sink failures are contained
and never alter delivery.

## Central wiring points

- `agent/channels/types.ts`: `OutboundMessage`, `OutboundButton`,
  `OutboundQueue`, and `OutboundQueueResult` contracts.
- `agent/channels/transport-factory.ts`: store construction, mode selection,
  transport sender adapter, text chunking, startup, and shadow fallback.
- `agent/channels/telegram/transport.ts`: private strict
  `TelegramOutboundSender` used by both text and button sends.
- `agent/poller/poller.ts`: queue construction, call sites, metrics adapter,
  queue-depth sampling, and shutdown.

The Integrator added production-seam tests in
`agent/channels/transport-factory.test.ts`. They prove structured buttons retain
their label/action schema through shadow persistence and that a real transport
429 becomes a classified `OutboundSendError` whose `retry_after` drives the
outer outbox retry schedule.

## Files changed by this audit

- `agent/delivery/outbound/store.ts`
- `agent/delivery/outbound/outbox.test.ts`
- `agent/delivery/outbound/telegram-sender.ts`
- `agent/delivery/outbound/telegram-sender.test.ts`
- `agent/delivery/outbound/INTEGRATION.md`

## Verification

- `bun test agent/delivery/outbound`: 26 passed, 0 failed.
- `bun test agent/channels/transport-factory.test.ts agent/delivery/outbound`:
  32 passed, 0 failed.
- `bun test agent`: 540 passed, 0 failed.
- `git diff --check`: passed.

Coverage includes durable-before-send, real Telegram ID, structured-button
round trip, cross-instance deduplication, 429 retry-after, bounded exponential
jitter, 5xx (including malformed JSON), dead-letter, uncertain result,
process-kill recovery, corrupt state, disk-full-before-send, 0600/temp cleanup,
record/queue/terminal/corrupt limits, response-buffer limit, full-body timeout,
and caller cancellation.

## Remaining risks and operator trade-offs

- Telegram `sendMessage` has no idempotency key. `uncertain` records require
  operator reconciliation or an explicit future redrive policy; replaying them
  automatically could duplicate a user-visible message.
- Completed retention makes deduplication count-bounded, not permanent. Once an
  old completed record falls outside the newest 10,000, reusing its delivery key
  can send again. Raising the cap increases the dedupe window and disk bound;
  lowering it does the opposite.
- Dead-letter and corrupt retention are also count-bounded. Operators must copy
  diagnostics elsewhere if longer forensic history is required.
- The file store is a single-consumer design and has no cross-process lease or
  lock. Production must construct only one active poller/outbox for a store.
- Store retention/capacity values are programmatic options. Central production
  wiring currently uses the documented defaults rather than environment
  overrides.
- There is no operator-facing dead-letter/uncertain inspect-and-redrive command
  in this module. Records are inspectable on disk, but manual mutation is not a
  supported API.
