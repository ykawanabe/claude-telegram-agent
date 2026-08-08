# Security policy

## Threat model

This project lets you talk to [Claude Code](https://code.claude.com) on your Mac from Telegram. It does so by running Claude with `--dangerously-skip-permissions`, which means **every tool call Claude makes is auto-approved**.

Practically:

- The user and chat recorded in `~/.pager/paired.json` can read, write, and execute on your Mac with the same scope Claude has.
- That includes browsing your files, modifying source code, running shell commands, calling MCP servers, hitting APIs you're logged into, and so on.

If your bot token or pairing code leaks, **assume your Mac has been compromised** until you rotate the token/code and inspect `~/.pager/paired.json`.

## Defenses this project provides

- **Paired identity policy.** Pairing writes both the Telegram chat ID and numeric user ID to `~/.pager/paired.json`. The poller requires both values to match on every inbound message and button press. Legacy `MAIN_CHAT_ID`-only configuration is ignored.
- **Compatibility allowlist.** `install.sh` may also write `~/.claude/channels/telegram/access.json` for Telegram-channel compatibility. It is not the poller's authorization boundary; `paired.json` is.
- **Token storage.** The bot token lives at `~/.claude/channels/telegram/.env` with mode `600` (owner read/write only), in a directory with mode `700`. The installer never echoes the token to stdout.
- **Local-only.** No data leaves your Mac except Telegram messages routed through Telegram's API. There is no telemetry, no third-party logging, no remote update mechanism.
- **No automatic privilege escalation.** The agent runs as your user. It does not request `sudo`.

## Defenses this project does NOT provide

- **No sandboxing.** The bot inherits your user's full shell privileges by design.
- **No per-message confirmation.** Once the bot is up, every message becomes an instruction that Claude executes. Use Claude Code's interactive mode if you want per-tool approval.
- **No encryption at rest.** The bot token is plaintext on disk (mode 600, but plaintext). If your Mac is unlocked and another process can read your files, they can read the token.
- **No code signing for the bash scripts.** Install scripts run as your user; you are trusting the contents of this repo.

## Reporting a vulnerability

If you find a security issue, please **do not file a public GitHub issue**. Use GitHub's [Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repo — click **Report a vulnerability** under the Security tab. I'll acknowledge within 72 hours.

If the issue is in Claude Code itself rather than this repo, please report it to Anthropic instead — see <https://www.anthropic.com/security>.

## Hardening checklist (for users)

Run through this before relying on the bot:

- [ ] `~/.pager/paired.json` contains the expected `chat_id` and your numeric Telegram `user_id`.
- [ ] `~/.claude/channels/telegram/.env` is mode `600` (`ls -l ~/.claude/channels/telegram/.env` shows `-rw-------`).
- [ ] Your bot's username (from `@BotFather` → `/mybots`) is not posted publicly.
- [ ] Two-factor authentication is enabled on your Telegram account.
- [ ] If you ever paste the token into a chat or screenshot, regenerate it via `@BotFather` → `/revoke` immediately.
- [ ] You are running on a Mac that's locked when unattended (filevault, screen lock, etc.).

If any of those make you uncomfortable, don't run this. Use Claude Code's built-in `/telegram:configure` flow instead — it supports per-message approval mode.
