# Reliability test harness

Run the deterministic unit/fault suite:

```sh
bun test tests/reliability
```

Run the synthetic soak harness (JSON summary and non-zero exit on threshold failure):

```sh
bun tests/reliability/load-harness.ts \
  --duration-ms 30000 \
  --concurrency 16 \
  --rate 100 \
  --latency-ms 2 \
  --max-failure-rate 0.01
```

Fault injection is disabled unless rules are supplied directly or through
`CTA_FAULT_PLAN`. Example:

```sh
CTA_FAULT_PLAN='[
  {"point":"inbound.after-claim","kind":"kill"},
  {"point":"outbox.persist","kind":"disk-full"},
  {"point":"telegram.send","kind":"timeout","delayMs":10},
  {"point":"journal.read","kind":"corrupt-state","corruption":"invalid-json"}
]' bun test tests/reliability/fault-injection.test.ts
```

Reliability policy defaults to `CTA_RELIABILITY_MODE=shadow`. Shadow emits the
same comparisons as enforced mode but never blocks. After the configured number
of healthy evaluation windows reports `promotionReady: true`, restart with
`CTA_RELIABILITY_MODE=enforced` to apply those comparisons as gates.
