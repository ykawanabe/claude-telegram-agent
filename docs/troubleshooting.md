# Troubleshooting

## Agent not running after login

The agent is two `launchd` jobs: the poller (`com.claude-agent`) and the
watchdog (`com.claude-watchdog`). Check them:

```sh
cta status
launchctl list | grep com.claude
```

If a job isn't loaded, `cta start` loads both. To force a clean restart:

```sh
cta stop
cta start
```

Then inspect the logs:

```sh
tail -n 100 ~/.pager/agent.log
tail -n 100 ~/.pager/agent.err.log
```

## `claude: command not found` inside the LaunchAgent

LaunchAgents don't inherit your shell's PATH. `install.sh` resolves the
absolute paths to `bun` and `claude` at install time and bakes them into the
plist / `start_agents.sh`. If you move or reinstall either binary afterward,
rerun `./install.sh` so the paths are re-resolved.

## Telegram messages not arriving in Claude

1. Confirm the bot token is present: `~/.claude/channels/telegram/.env` should
   hold `TELEGRAM_BOT_TOKEN=...`. A rejected token fails the poller's startup
   preflight — `~/.pager/agent.log` says so on the first lines after a restart.
2. Confirm `~/.pager/paired.json` matches both this chat and your Telegram user
   ID. Any mismatch is silently dropped.
3. Confirm the chat is paired: `cta status` shows the paired chat, or send
   `/pair <code>` (run `cta pair-code` to see the code).
4. Watch it live: `tail -f ~/.pager/agent.log` shows each inbound update being
   routed to its topic's `claude` daemon.

## The bot stopped responding after a network blip

The watchdog (`com.claude-watchdog`) kickstarts the poller whenever its
heartbeat (`~/.pager/heartbeat-poller`) goes stale, so a hung poller heals
itself within a couple of minutes. To force it now: `cta start`. To confirm
both jobs are alive: `cta status`.

## How to stop everything temporarily

```sh
cta stop      # unloads both LaunchAgents; SIGTERMs the poller + its claude daemons
```

Bring it all back with `cta start`.

## The bot goes silent when the Mac is idle (sleep / standby / powernap)

The poller is a **continuous long-poll** — it has to be running every second to
receive inbound Telegram updates. When the Mac idle-sleeps, or (on Apple
Silicon) drops into a `standby`/`powernap` maintenance nap, the process is
frozen and messages sent during that window are missed. It looks like the bot
"silently stopped replying," then springs back the moment you touch the
machine.

`caffeinate` is the **weak lever** here: `caffeinate -i` only blocks idle
*system* sleep — it does **not** prevent standby or powernap, so on Apple
Silicon the poller still freezes for most of each maintenance cycle. That's why
the Pager's "Keep Mac awake" toggle now defaults **off**.

The real fix is `pmset`. Run once on the host (needs sudo):

```sh
cta config sleep-fix on        # → sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0
```

Check the current state any time:

```sh
cta config sleep-fix status    # or look for the "Sleep-fix:" line in `cta status`
```

Caveats (the same ones OpenClaw's gateway runbook documents — this is a shared
macOS constraint, not a bug in this project):

- pmset *significantly reduces but doesn't entirely eliminate* maintenance
  sleep (the OS still wakes briefly for TCP-keepalive / mDNS upkeep). The
  watchdog (`com.claude-watchdog`) re-arms the poller after those.
- It does **not** survive closing a laptop lid (clamshell sleep). For genuine
  24/7 reachability, run the agent on a never-sleep desktop Mac (a Mac mini set
  to never sleep) or move the poller to an always-on Linux host.

Revert with `cta config sleep-fix off` (sets macOS default sleep policy —
overwrites any custom pmset values; the bot can go silent on idle again).

## Mid-turn messages and `/stop`

By default, a message you send while Claude is working will **steer** the running task: the agent waits ~1.5 seconds (in case more messages follow), then interrupts Claude gracefully and processes your new message next. The session and conversation history are preserved — only the in-flight turn is aborted.

- **`/stop`** — explicit halt. Sends the same graceful interrupt and acks "⏹ Stopped."; your next message resumes the same session.
- **Mid-turn messages are debounced.** If you send several messages in quick succession, only one interrupt fires (after the last message settles). All messages accumulate in the queue and flow into the next turn together.
- **To disable steering** — so new messages always wait until the current task finishes — run `cta config interrupt-steer off` on the host, or toggle "Mid-turn steering" off in Pager Settings. Re-enable with `cta config interrupt-steer on`. Changes apply within ~25 seconds without restarting the agent.
- **If a steer seems to "hang" the topic for a few seconds, then it recovers:** the underlying `claude` CLI sometimes accepts an interrupt without ending the turn. The agent waits ~12 seconds for the interrupt to take, and if nothing comes back it restarts that topic's Claude (your session resumes, queued messages are sent). Tunable via `PAGER_INTERRUPT_ESCALATE_MS`. Before this guard the stall could last ~5 minutes.
