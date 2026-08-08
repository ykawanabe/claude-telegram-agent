# Test Plan

A living document of failure modes this project has hit, the test that
catches each, and the gap if no test exists. Add to this every time a
regression bites us — the failure-mode column is the contract; the
test-name column is the proof.

The hard rule: when you fix a bug, find or write the row that covers it.
If you can't, the same bug will resurface and we'll re-spend the time.

## How to run

```sh
tests/run.sh                              # all unit + shell tests, ~5s
bun test services/poller/poller.test.ts   # poller unit tests (subset)
tests/test_send_telegram_e2e.sh           # claude+MCP behavior; costs real API tokens (opt-in)
```

## Layers

| Layer | What it tests | Speed | Cost | Where |
|---|---|---|---|---|
| Unit | Pure logic of a single function | <1s total | free | `*.test.ts`, `tests/test_*.sh` |
| Shell | bash primitives, tmux dispatch contract | <2s | free | `tests/test_*.sh` |
| E2E (mocked) | claude actually calls send_telegram given our prompt + MCP | ~30s | ~$0.50/run (Anthropic API) | `tests/test_send_telegram_e2e.sh` |
| Live smoke | Real Bot API + real claude + real tmux | manual | real Telegram + Anthropic | the user reports back |

E2E is opt-in (not in `tests/run.sh`) because it spends real money.

## Failure mode matrix

| # | Failure mode | First seen | Covered by | Status |
|---|---|---|---|---|
| 1 | `/pair` wrong-code does not claim chat | early | `poller.test.ts: /pair with wrong code does NOT claim chat` | ✓ |
| 2 | `/pair` from non-paired user falls through | early | `poller.test.ts: commands from non-paired user_id are silently dropped` | ✓ |
| 3 | Paired-chat routing strict vs. permissive | live | `poller.test.ts: effectiveChatId prefers paired.json over env` + `drop msg ... reason=wrong-chat` log assertion (manual) | partial |
| 4 | Stale topic-* tmux session after kill | live | `poller.test.ts` (indirect — autoSpawn coverage) + manual via `respawned tmux session: ...` log | ✓ |
| 5 | Stale `mcp-telegram` env after re-pair | live | `topic-wrapper.sh` reads `paired.json` (verified live `TELEGRAM_CHAT_ID` matches) | live-only ⚠ |
| 6 | claude doesn't call send_telegram (silent reply in TUI) | live | `tests/test_send_telegram_e2e.sh` | ✓ |
| 7 | `mcp-telegram` ignores `TELEGRAM_API_BASE` | live (test ↑) | `services/mcp-telegram/server.ts` const + `tests/test_send_telegram_e2e.sh` | ✓ |
| 8 | mounts.json wiped on unpair, next message has no route | live | `poller.test.ts: /pair from paired user in NEW chat switches paired.json` (covers `ensureWildcardMount`) | ✓ |
| 9 | Pair switch leaves stale topic-* with old chat_id pinned | live | `poller.test.ts: /pair from paired user in NEW chat switches paired.json` (asserts `killAllTopicSessions` runs) | partial — assertion is by side-effect only |
| 10 | LaunchAgent's KeepAlive doesn't restart cleanly-exited start_agents.sh | live | manual; relies on `launchctl kickstart` | gap ⚠ |
| 11 | `cta status` reports `claude=✗` in MULTI_TOPIC mode | live | `tests/test_cta.sh: json (MULTI_TOPIC): tmux.claude → poller` | ✓ |
| 12 | Pager's "Watch bot live" attaches to dead v0 `claude` session | live | manual; Pager test infra would need an XCUITest run | gap ⚠ |
| 13 | dispatch race when 4 messages arrive within 40 ms | live | manual; no test (would need scriptable claude TUI) | gap ⚠ |
| 14 | Pager `openTerminal` body uses `exec` and breaks multi-line scripts | live | manual; Pager rebuild + click "Watch bot live" | gap ⚠ |
| 15 | Group bot status `member` → Telegram filters plain text | live | manual; Telegram-side behavior, not our code | doc-only ⚠ |
| 16 | Resumed claude session ignores updated system prompt | live | `tests/test_send_telegram_e2e.sh` always runs `--session-id` fresh, no `--resume` | ✓ |
| 17 | `cta config ack` toggle didn't fire any reaction | live | `poller.test.ts: reactToMessage fires setMessageReaction when ackReaction is set` + `ackReaction reloads when access.json mtime changes` | ✓ |
| 18 | Bot ack toggle in Pager not wired to poller behavior | live | `poller.test.ts` (above) covers the read side; Pager-write side covered by `SettingsView.swift` writing to `access.json` | ✓ |
| 19 | No "typing…" indicator while claude is thinking | live | `poller.test.ts: sendTyping fires sendChatAction with 'typing' action` | ✓ |
| 20 | `tmux dispatch` test counts global buffers, fails when live agent shares the server | live | `tests/test_tmux_dispatch.sh` — delta-based check | ✓ |
| 21 | `paste-buffer -d` race: messages stack as multi-line prompt instead of separate submits | live | no test (claude TUI behavior; would need TUI scripting) | gap ⚠ |
| 22 | Cursor advances before inbound work is durable, losing a Telegram update on crash | Wave 1 | `agent/delivery/inbound/journal.fault.test.ts` + `agent/channels/telegram/transport.test.ts` | ✓ |
| 23 | Crash after dispatch causes an unsafe automatic duplicate | Wave 1 | `journal.fault.test.ts: replays received and claimed, but quarantines dispatched` | ✓ |
| 24 | Telegram 429/5xx output disappears instead of retrying with server delay | Wave 1 | `agent/delivery/outbound/outbox.test.ts` + `telegram-sender.test.ts` | ✓ |
| 25 | Telemetry ENOSPC/corruption unwinds delivery or hides all prior events | Wave 1 | `tests/reliability/events.test.ts` + `fault-injection.test.ts` | ✓ |

## Gaps (P1 → P4)

P1 — fix next:
- **#9** Pair switch side-effect (kill of stale topic-*) asserted only by absence of regression. Add a unit test that stubs `tmux list-sessions` and verifies the kill list.
- **#13/#21** dispatch race / prompt stacking. Either add a small "is claude prompt ready?" probe (tmux capture-pane grep for `❯ `) before each Enter, or batch consecutive updates into one paste with newlines.

P2:
- **#12** Pager attach behavior — a smoke script that runs `tmux attach -t poller` headlessly and confirms exit 0.
- **#10** LaunchAgent reload semantics — a tests/test_launchagent.sh that loads/unloads the plist in a sandbox and verifies KeepAlive triggers a restart.

P3:
- **#3** Drop-reason logging is only asserted by manual log inspection. Add a unit test that captures stderr in a tmpfile and greps for the expected drop reasons.

P4 (doc-only, won't be fixed in code):
- **#15** Group bot privacy — Telegram-side. Pager surfaces this in the bot-added intro now; nothing more we can do from code.

## Adding a new failure mode

1. Reproduce in a test file (unit > shell > E2E, whichever's cheapest).
2. Add a row to the matrix with a one-line description and the test-id path.
3. Commit alongside the fix.
4. If a test can't capture it: write "gap ⚠" and put it in the P-list above.
