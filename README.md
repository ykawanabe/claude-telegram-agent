# Claude Pager

Use [Claude Code](https://code.claude.com/) from your phone, through the chat apps you already have. A local CLI bridges your chat app to Claude Code on your Mac, and a tiny menu bar app sits on top to drive it. Telegram only, for now. Nothing goes through a third party server: the bridge runs locally, and survives crashes, network blips, and reboots.

`install.sh` wires together three things:

1. A `launchd` LaunchAgent that runs the **poller**: one Telegram long-poll loop. With Pager installed, the poller is launched through the menu bar app (`Claude Pager.app --agent-launcher`) so macOS attributes its file access to "Claude Pager"; a CLI-only install runs `bun` directly.
2. The poller routes each chat (and each forum topic) to its own long-lived `claude` session (`claude -p --input-format stream-json`, one daemon per topic), through a small platform-agnostic `ChatTransport` layer. Replies, the 👀→👌 read receipts, the typing indicator, and inline buttons all flow back through it.
3. A second LaunchAgent, the **watchdog**, kickstarts the poller when its heartbeat goes stale. It catches hangs that `launchd`'s own crash-respawn would miss.

No `tmux`, no separate outbound server. `install.sh` also (optionally) provisions the bot token and allowlist under `~/.claude/channels/telegram/`, so once it finishes, the bot is live.

## Requirements

- macOS (Apple Silicon or Intel)
- `bash` (the scripts are bash, not zsh)
- [`claude`](https://code.claude.com/docs/en/getting-started) v2.1.80+ on `PATH`
- `bun` on `PATH` (runs the poller and the `cta` helpers)
- `jq` on `PATH` (`install.sh` offers to `brew install` it if missing)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram numeric user ID — DM [@userinfobot](https://t.me/userinfobot), or [@username_to_id_bot](https://t.me/username_to_id_bot) / [@getmyid_bot](https://t.me/getmyid_bot) if the first one's offline

## Install

```sh
git clone https://github.com/ykawanabe/pager-for-agents.git
cd pager-for-agents
chmod +x install.sh
./install.sh                  # interactive: also offers to install Pager
# or:
./install.sh --with-pager     # always install both
./install.sh --no-pager       # CLI-only, headless setups
```

You'll be prompted for one thing: the Telegram bot token from
[@BotFather](https://t.me/BotFather). Paste it (silent input). When install
finishes, the last line printed is your **pairing code**:

```
═══════════════════════════════════════════════════════════
  PAIRING CODE:  XXXX-XXXX
═══════════════════════════════════════════════════════════
```

## Pair the bot from Telegram

After install, the bot is running but isn't connected to a chat yet. Pairing fixes that.

### DM (easiest case)

1. Search Telegram for your bot's @username and open a chat.
2. Send `/pair XXXX-XXXX` using the pairing code `install.sh` printed (re-show it any time with `cta pair-code` on your Mac).

Every message you DM the bot now reaches claude.

### Group or forum group

Groups need one extra step, because of a Telegram default:

1. Open [@BotFather](https://t.me/BotFather), send `/setprivacy`, pick your bot, choose **Disable**. Otherwise, in groups, the bot only sees messages that @-mention it or reply to its own. (DMs aren't affected; this is a group-only quirk.)
2. Invite the bot to the chat.
3. Send `/pair XXXX-XXXX` in the group. Only the person who invited the bot can pair it.

In a forum group, every topic spawns its own claude session in whatever default project dir you picked at install. Pin a topic to a different dir with `/mount ~/path` inside it.

### Host-side pairing (skip the code)

You can also pair straight from your Mac, no Telegram code round-trip:

```
cta pair --auto                # list chats the bot has recently seen, then pick one
cta pair <chat_id> [user_id]   # claim a chat directly (negative chat_id + your user_id for groups)
```

### Available commands

Send these inside Telegram (in the paired chat, as the paired user):

| Command | Where | What |
|---|---|---|
| `/pair <code>` | Any chat | One-time pairing (consumed on success) |
| `/start` | Any chat | Welcome message + pairing hint |
| `/mount <path>` | Inside a forum topic | Bind that topic to a Mac directory |
| `/dm <path>` | In the bot's DM | Bind the DM to a Mac directory |
| `/unmount` | The mounted topic/DM | Remove that mount |
| `/list` | Anywhere | Show current mounts |
| `/help` | Anywhere | List commands |
| `/stop` | The active topic | Abort the running Claude turn; your next message resumes the same session |
| `/do <task>` | The active topic | Delegate a one-off task — Claude acts on the safe, reversible steps and asks before anything risky |
| `/task` | Anywhere | Scheduled tasks: list them, or `run` / `on` / `off` / `rm <name>` to manage |

### Host-side commands (terminal)

| Command | What |
|---|---|
| `cta status` | Health snapshot (poller + watchdog LaunchAgents, last activity) |
| `cta start` / `cta stop` | Restart / stop the agent |
| `cta pair-code` | Re-display the pairing code |
| `cta pair-code --reset` | Regenerate (invalidates the previous code) |
| `cta list` | Same as `/list` but in your terminal |
| `cta mount <thread> <path>` | Same as `/mount` but in your terminal |
| `cta config idle-evict <min>` | Evict idle Claude sessions after N minutes to free RAM (`0` = off; default 15 min). Quiet topics are closed and resume on your next message; same knob as the Pager "Memory" toggle. At most two idle daemons remain warm by default (`MAX_WARM_DAEMONS=0` disables that cap). Applies within ~25s, no restart |
| `cta config interrupt-steer <on\|off>` | Mid-turn steering (`on` by default). When on, a message sent while Claude is working interrupts and redirects it after a ~1.5s debounce. Set `off` to make new messages queue until the current task finishes. Same knob as the Pager "Mid-turn steering" toggle. Applies within ~25s, no restart |
| `cta config sleep-fix <on\|off\|status>` | Harden macOS power settings so the poller never freezes when the Mac idles. `on` runs `sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0`; `status` reports it. See [troubleshooting](docs/troubleshooting.md) |
| `cta task list` | List proactive scheduled tasks + each one's last-fire status |
| `cta task add\|template\|run\|on\|off\|rm …` | Create / scaffold / fire-now / toggle / remove a scheduled task — its own time, days (incl. `monthly:<1-31>` / `every:<N>`), and topic. Runs through the same safety gate (read-only + drafts unattended); `--notify-only-if <marker>` keeps quiet days silent. Also in the Pager app's Tasks tab |

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/pair` is silent, no reply at all | Pairing code already consumed | `cta pair-code --reset` on host, retry with new code |
| `/pair … did not match` | Wrong code | Run `cta pair-code` to see the current value |
| Bot doesn't respond to anything | Token rejected by Bot API (preflight failed) | Check `~/.claude/channels/telegram/.env`, rerun `./install.sh` |
| `/mount` says "not a directory" | Path doesn't exist on the Mac | Use full path, no relative or shell-globbed paths |
| `/mount` says "inside a forum topic" | You sent it in the chat root, not a topic | Open a topic and resend, or use `/dm` for the DM mount |
| Messages arrive but no claude reply | poller hung, or a topic's claude died | `cta status` to check; `tail -f ~/.pager/agent.log` to inspect; `cta start` to restart |
| Want to start over | — | `cta stop`, delete `~/.pager/paired.json`, `cta pair-code --reset`, `cta start` |

## Where the secrets live

| Path | What | Mode |
|---|---|---|
| `~/.pager/.env` | Agent config (paths, ping target) | 644 |
| `~/.claude/channels/telegram/.env` | `TELEGRAM_BOT_TOKEN=...` | 600 |
| `~/.claude/channels/telegram/access.json` | Allowlist policy | 600 |
| `~/Library/LaunchAgents/com.claude-agent.plist` | Poller LaunchAgent | 644 |
| `~/Library/LaunchAgents/com.claude-watchdog.plist` | Watchdog LaunchAgent | 644 |

The poller reads the bot token from `~/.claude/channels/telegram/.env` directly. There's no separate Telegram channel plugin or MCP server in the loop anymore.

## Security: read this before you run it

The poller spawns each topic's `claude` with `--dangerously-skip-permissions`. That flag means:

- **Every tool call is auto-approved.** Claude can read, write, and execute on your system without prompting.
- **The paired Telegram user has the same privileges Claude has.** If your bot token or pairing code leaks, treat that as remote-shell exposure and inspect `~/.pager/paired.json`.

Mandatory hardening:

1. Pair explicitly. Run `cta pair-code`, then send `/pair <code>` from the intended Telegram account and chat. Verify both `chat_id` and `user_id` in `~/.pager/paired.json`.
2. Don't share the bot token. It lives at `~/.claude/channels/telegram/.env` with `chmod 600`. Don't commit it, don't paste it into chats.
3. Treat this Mac as the trusted machine. Don't run the agent on a shared or unattended computer.
4. Audit now and then. `tail -f ~/.pager/agent.log` shows what Claude is doing in real time.

If any of those bullets makes you uncomfortable, **do not run this**. Use the official `/telegram:configure` interactive flow inside Claude Code instead; it has a per-message approval mode.

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md).

Common issues:

- `claude: command not found` from the LaunchAgent: a PATH issue in the plist, see the troubleshooting doc.
- Messages not arriving: check `~/.pager/paired.json` matches both the current chat and your Telegram user ID.
- The bot doesn't reconnect after a network outage: run `cta status`. The watchdog kickstarts a stale poller on its own, or `cta start` forces it.
- The bot goes silent when the Mac sits idle: macOS idle-sleep (and Apple-Silicon standby/powernap) freeze the poller. Run `cta config sleep-fix on` (needs sudo); for true 24/7, run on a never-sleep Mac or a Linux host. See the [troubleshooting doc](docs/troubleshooting.md).

## Development

Run the shell test suite locally:

```sh
tests/run.sh
```

Covers the `cta` CLI, the mount-store, the LaunchAgent entrypoints, the watchdog, and the `check-no-secrets` pre-commit hook. CI runs the same suite on every push. The TypeScript unit tests live alongside the code (`cd agent && bun test`); the agent-runnable end-to-end harness is `tests/e2e/run.sh`. The test suite needs `tmux` (it simulates per-topic sessions): `brew install tmux`. The runtime itself doesn't use tmux.

## Uninstall

```sh
./uninstall.sh                  # leaves Telegram secrets in place
./uninstall.sh --purge-telegram # also removes ~/.claude/channels/telegram
```

Both modes back up `.env` files into `~/.pager-backup-<timestamp>/` first.

## Project layout

```
.
├── install.sh / uninstall.sh        Top-level installers (chains pager/ optionally)
├── cli/cta                          User-facing CLI (status, mount, pair, …)
├── agent/                           Runtime
│   ├── start_agents.sh              LaunchAgent entry — exec's the poller (launchd-supervised)
│   ├── watch_network.sh             Watchdog — kickstarts the poller if its heartbeat goes stale
│   ├── poller/                      Telegram long-poll → per-topic claude daemons (stream-json)
│   ├── channels/                    ChatTransport — platform-agnostic core + the Telegram adapter
│   └── mount-store/                 mounts.json read/write with O_EXCL lock
├── launchagent/                     com.claude-agent.plist template
├── tests/                           bun + shell test suite
├── docs/                            Prose docs + the published landing page (GitHub Pages)
│   ├── test-plan.md                 Failure-mode matrix
│   └── troubleshooting.md
├── scripts/                         Dev tooling (check-no-secrets pre-commit)
├── skills/                          Claude Code skills
└── pager/                           Companion macOS menu bar app (Claude Pager)
    ├── Sources/ClaudePager/         SwiftUI app
    ├── Package.swift
    └── install.sh                   Builds + signs + installs as a LaunchAgent
```

Pager was its own repo (`claude-telegram-agent-bar`, archived) until
2026-05-13; merged in because they ship together and share `cta` as the
contract.

## Acknowledgements

Architectural ideas borrowed from:

- [RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) — Python SDK version
- [shaike1/relay](https://github.com/shaike1/relay) — multi-agent variant
- [Claude Code Channels docs](https://code.claude.com/docs/en/channels)

## License

[MIT](LICENSE)
