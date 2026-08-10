#!/bin/bash
# Interactive installer for claude-telegram-agent on macOS.
#
# Copies scripts into ~/.local/bin, writes ~/.pager/.env (state dir),
# registers a LaunchAgent to start everything at login, and (optionally)
# provisions the Claude Code Telegram plugin secrets at the canonical
# location the plugin reads from automatically:
#
#   ~/.claude/channels/telegram/.env         (TELEGRAM_BOT_TOKEN=...)
#   ~/.claude/channels/telegram/access.json  (allowlist policy)
#
# That path is auto-discovered when claude is launched with
# `--channels plugin:telegram@claude-plugins-official`, so no extra wiring
# is needed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# State + install dirs. Defaults match agent/lib/paths.ts and cli/cta. Env
# overrides flow through so a single shell can target a non-default layout
# for testing or operator customization.
STATE_DIR="${CTA_STATE_DIR:-$HOME/.pager}"
INSTALL_DIR="${CTA_INSTALL_DIR:-$HOME/.local/share/pager}"
LEGACY_STATE_DIR="$HOME/.claude-telegram-agent"
LEGACY_INSTALL_DIR="$HOME/.local/share/claude-telegram-agent"

# Auto-migrate v0.1 layouts before any deploy steps touch the new paths.
# Idempotent — exits silently when there's nothing to move. Refuses if the
# poller is still alive against the legacy dir; user must `cta stop` first.
if [[ -d "$LEGACY_STATE_DIR" || -d "$LEGACY_INSTALL_DIR" ]]; then
  printf "→ Detected v0.1 layout — migrating to v0.2 paths\n"
  if ! bash "$REPO_DIR/cli/cta" migrate-state; then
    printf "✗ migrate-state failed — aborting install. Resolve and re-run.\n" >&2
    exit 1
  fi
fi

CONFIG_DIR="$STATE_DIR"
BIN_DIR="$HOME/.local/bin"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_LABEL="com.claude-agent"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${PLIST_LABEL}.plist"
# P6c: the network/heartbeat watchdog is its own launchd job (was a tmux session).
WATCHDOG_LABEL="com.claude-watchdog"
WATCHDOG_PLIST_PATH="$LAUNCH_AGENTS_DIR/${WATCHDOG_LABEL}.plist"

# Canonical path the Claude Code Telegram plugin reads from.
TELEGRAM_DIR="$HOME/.claude/channels/telegram"
TELEGRAM_ENV="$TELEGRAM_DIR/.env"
TELEGRAM_ACCESS="$TELEGRAM_DIR/access.json"

say() { printf "→ %s\n" "$*"; }
die() { printf "✗ %s\n" "$*" >&2; exit 1; }

# ---- 1. Dependency check ----------------------------------------------------
say "Checking dependencies"

require() {
  local cmd="$1" hint="$2" brew_pkg="${3:-}"
  if command -v "$cmd" >/dev/null 2>&1; then
    return
  fi

  if [[ -n "$brew_pkg" ]] && command -v brew >/dev/null 2>&1; then
    say "Missing dependency: $cmd"
    printf "  Install via 'brew install %s'? [Y/n] " "$brew_pkg"
    read -r answer
    case "${answer:-y}" in
      [Yy]*|"")
        brew install "$brew_pkg" || die "brew install $brew_pkg failed. Manual install: $hint"
        return
        ;;
    esac
  fi

  die "Missing dependency: $cmd
  Install: $hint"
}

# Last arg = Homebrew formula; if present and brew is on PATH, installer offers
# 'brew install <formula>' interactively before bailing out.
require claude "npm install -g @anthropic-ai/claude-code  (or use bun/pnpm)"
require bun    "brew install oven-sh/bun/bun  (or curl -fsSL https://bun.sh/install | bash)"  "oven-sh/bun/bun"
require jq     "brew install jq"                                                              "jq"

CLAUDE_VERSION="$(claude --version 2>/dev/null || echo unknown)"
say "Detected claude: $CLAUDE_VERSION"

# ---- 2. Write agent .env ----------------------------------------------------
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ -f "$CONFIG_DIR/.env" ]]; then
  say ".env already exists at $CONFIG_DIR/.env — leaving it alone"
else
  # umask 077 so the cp lands at 0600 — matches the plugin's .env at
  # ~/.claude/channels/telegram/.env. The agent .env holds CLAUDE_CWD (a
  # path that reveals project location) and BOT_SESSION_ID; not as
  # devastating as a token leak, but no reason to ship it world-readable.
  (umask 077 && cp "$REPO_DIR/.env.example" "$CONFIG_DIR/.env")

  default_cwd="$HOME/claude-home"
  printf "\nEnter the Claude Code working directory [%s]: " "$default_cwd"
  read -r CLAUDE_CWD_INPUT
  CLAUDE_CWD_INPUT="${CLAUDE_CWD_INPUT:-$default_cwd}"

  # Escape sed-replacement metacharacters in the user-supplied path so a
  # directory containing '|', '&', or '\' doesn't corrupt the .env line.
  esc_cwd=$(printf '%s' "$CLAUDE_CWD_INPUT" | sed -e 's/[\\&|]/\\&/g')
  sed -i '' "s|^CLAUDE_CWD=.*|CLAUDE_CWD=${esc_cwd}|" "$CONFIG_DIR/.env"
  say "Wrote $CONFIG_DIR/.env (CLAUDE_CWD=$CLAUDE_CWD_INPUT)"
fi

# Generate a stable session UUID if one isn't already present. With it,
# `restart_claude.sh` passes `--session-id $BOT_SESSION_ID` so the bot resumes
# the same Claude Code conversation across restarts (sleep, crash, kick).
# Without it, every restart wipes context — bad UX for a chat bot.
# This is a v0 patch; multi-topic mode replaces it with per-topic sessions.
if ! grep -q '^BOT_SESSION_ID=..*' "$CONFIG_DIR/.env" 2>/dev/null; then
  bot_uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')
  printf '\nBOT_SESSION_ID=%s\n' "$bot_uuid" >> "$CONFIG_DIR/.env"
  say "Generated BOT_SESSION_ID=$bot_uuid for conversation persistence"
fi

# MULTI_TOPIC=1 is the Phase 1+ default. Older .env files written before the
# Phase 1+ default switch lack the line entirely; without it start_agents.sh
# silently falls back to the v0 single-topic path, leaving group / forum-topic
# features unreachable. Append (don't replace — operators who explicitly set
# MULTI_TOPIC=0 want the v0 path kept).
if ! grep -q '^MULTI_TOPIC=' "$CONFIG_DIR/.env" 2>/dev/null; then
  printf '\nMULTI_TOPIC=1\n' >> "$CONFIG_DIR/.env"
  say "Enabled MULTI_TOPIC=1 (per-topic routing — the default since Phase 1+)"
fi

# Always clamp .env to 0600. Catches pre-existing installs that ran before
# we tightened the cp umask, and re-asserts on every run as cheap insurance.
chmod 600 "$CONFIG_DIR/.env" 2>/dev/null || true

# ---- 3. Install scripts -----------------------------------------------------
# Top-level structure post-merge (2026-05-13):
#   cli/cta                       — user-facing CLI
#   agent/{start,watch,restart}.sh — runtime entry points (LaunchAgent calls
#                                    agent/start_agents.sh)
#   agent/{poller,mount-store,    — runtime modules (data, copied to
#         lib,channels}              $INSTALL_DIR/agent)
mkdir -p "$BIN_DIR"
cp "$REPO_DIR/cli/cta" "$BIN_DIR/cta"
chmod +x "$BIN_DIR/cta"
say "Installed $BIN_DIR/cta"
for s in watch_network.sh start_agents.sh; do
  cp "$REPO_DIR/agent/$s" "$BIN_DIR/$s"
  chmod +x "$BIN_DIR/$s"
  say "Installed $BIN_DIR/$s"
done
# Phase 4 (2026-05-19): restart_claude.sh removed. Regular per-topic claude
# lifecycle is now owned by poller.ts → ClaudeDaemonRegistry. Delete any
# leftover from prior installs so the watchdog can't accidentally invoke it.
rm -f "$BIN_DIR/restart_claude.sh" 2>/dev/null || true

# ---- 3b. Install MULTI_TOPIC runtime modules --------------------------------
# Layout: $INSTALL_DIR/agent/{lib,poller,mount-store,channels}. Honors
# XDG-ish convention (executables in ~/.local/bin, data/code in
# ~/.local/share).
AGENT_DIR="$INSTALL_DIR/agent"
if [[ -d "$REPO_DIR/agent" ]]; then
  mkdir -p "$AGENT_DIR/lib" "$AGENT_DIR/poller" "$AGENT_DIR/poller/heartbeat-checks" "$AGENT_DIR/poller/agentic" "$AGENT_DIR/mount-store" "$AGENT_DIR/tasks-store" "$AGENT_DIR/channels/telegram" "$AGENT_DIR/delivery/inbound" "$AGENT_DIR/delivery/outbound" "$AGENT_DIR/observability"
  cp "$REPO_DIR/agent/lib/paths.ts" "$AGENT_DIR/lib/"
  cp "$REPO_DIR/agent/poller/poller.ts" \
     "$REPO_DIR/agent/poller/package.json" \
     "$REPO_DIR/agent/poller/contracts.ts" \
     "$REPO_DIR/agent/poller/bot-feature.ts" \
     "$REPO_DIR/agent/poller/transcript-cursor.ts" \
     "$REPO_DIR/agent/poller/claude-daemon.ts" \
     "$REPO_DIR/agent/poller/claude-daemon-registry.ts" \
     "$REPO_DIR/agent/poller/buttons-marker.ts" \
     "$REPO_DIR/agent/poller/slash-commands.ts" \
     "$REPO_DIR/agent/poller/watch-render.ts" \
     "$REPO_DIR/agent/poller/file-access-probe.ts" \
     "$AGENT_DIR/poller/"
  # H2 daily-digest heartbeat (Design A): registry + per-check handlers +
  # runner + scheduler + state/log/quiet-hours helpers. Production .ts only;
  # .test.ts files stay in the repo. Per
  # memory/project_install_sh_explicit_file_list.md, NEW files added under
  # this subtree must be listed here OR they silently don't deploy and the
  # poller's import would fail at module-load.
  cp "$REPO_DIR/agent/poller/heartbeat-checks/registry.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/open-prs.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/heartbeat-md.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/heartbeat-runner.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/heartbeat-state.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/heartbeat-log.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/quiet-hours.ts" \
     "$REPO_DIR/agent/poller/heartbeat-checks/scheduler.ts" \
     "$AGENT_DIR/poller/heartbeat-checks/"
  # Agentic 秘書 mode: autonomy policy + approval store + gate hook + runner +
  # cards. Production .ts only (.test.ts stay in the repo). gate-hook.ts runs as
  # a claude PreToolUse hook; the others are imported by the poller — without
  # these copies the installed poller crashes on startup ("Cannot find module").
  cp "$REPO_DIR/agent/poller/agentic/autonomy-policy.ts" \
     "$REPO_DIR/agent/poller/agentic/approval-store.ts" \
     "$REPO_DIR/agent/poller/agentic/gate-hook.ts" \
     "$REPO_DIR/agent/poller/agentic/agentic-runner.ts" \
     "$REPO_DIR/agent/poller/agentic/cards.ts" \
     "$AGENT_DIR/poller/agentic/"
  # Chat-channel modules (ChatTransport migration). Platform-agnostic core
  # contract (types.ts) + Telegram wire adapter. poller.ts imports the adapter
  # via ../channels/telegram/adapter; without these copies the installed poller
  # crashes on startup ("Cannot find module").
  cp "$REPO_DIR/agent/channels/types.ts" \
     "$REPO_DIR/agent/channels/transport-factory.ts" \
     "$AGENT_DIR/channels/"
  cp "$REPO_DIR/agent/channels/telegram/adapter.ts" \
     "$REPO_DIR/agent/channels/telegram/transport.ts" \
     "$REPO_DIR/agent/channels/telegram/typing-keepalive.ts" \
     "$AGENT_DIR/channels/telegram/"
  # Wave 1 durable delivery and reliability instrumentation. These are imported
  # by the transport factory, Telegram transport and poller at module load.
  cp "$REPO_DIR/agent/delivery/inbound/index.ts" \
     "$REPO_DIR/agent/delivery/inbound/journal.ts" \
     "$REPO_DIR/agent/delivery/inbound/journal.kill-fixture.ts" \
     "$REPO_DIR/agent/delivery/inbound/types.ts" \
     "$REPO_DIR/agent/delivery/inbound/INTEGRATION.md" \
     "$AGENT_DIR/delivery/inbound/"
  cp "$REPO_DIR/agent/delivery/outbound/index.ts" \
     "$REPO_DIR/agent/delivery/outbound/outbox.ts" \
     "$REPO_DIR/agent/delivery/outbound/store.ts" \
     "$REPO_DIR/agent/delivery/outbound/telegram-sender.ts" \
     "$REPO_DIR/agent/delivery/outbound/types.ts" \
     "$REPO_DIR/agent/delivery/outbound/INTEGRATION.md" \
     "$AGENT_DIR/delivery/outbound/"
  cp "$REPO_DIR/agent/observability/README.md" \
     "$REPO_DIR/agent/observability/INTEGRATION.md" \
     "$REPO_DIR/agent/observability/events.ts" \
     "$REPO_DIR/agent/observability/fault-injection.ts" \
     "$REPO_DIR/agent/observability/index.ts" \
     "$REPO_DIR/agent/observability/metrics.ts" \
     "$REPO_DIR/agent/observability/monitor.ts" \
     "$REPO_DIR/agent/observability/reliability-gate.ts" \
     "$AGENT_DIR/observability/"
  cp "$REPO_DIR/agent/mount-store/mount-store.ts" "$REPO_DIR/agent/mount-store/package.json" "$AGENT_DIR/mount-store/"
  # Scheduled-tasks store. poller.ts imports ../tasks-store/tasks-store; without
  # this copy the installed poller crashes on startup ("Cannot find module").
  cp "$REPO_DIR/agent/tasks-store/tasks-store.ts" "$AGENT_DIR/tasks-store/"
  # Phase 4 (2026-05-19): picker-watcher.ts removed (daemons via stream-json
  # own dispatch now). Delete any leftover from a stale install.
  rm -f "$AGENT_DIR/picker-watcher.ts" 2>/dev/null || true

  # Bot-scoped Claude Code hooks: PreCompact/PostCompact/Notification fire
  # status messages to Telegram during otherwise-silent windows. Passed to
  # claude via --settings by the poller daemon so they only affect bot
  # sessions, not the user's desktop Claude Code.
  HOOKS_DIR="$AGENT_DIR/../hooks"
  mkdir -p "$HOOKS_DIR"
  cp "$REPO_DIR/agent/hooks/pager-notify.sh" "$HOOKS_DIR/pager-notify.sh"
  chmod +x "$HOOKS_DIR/pager-notify.sh"
  # Substitute __HOOKS_DIR__ → absolute path at install time. Claude Code's
  # --settings treats hook "command" strings as literal shell paths; it does
  # NOT expand env vars, so a literal `$HOME/...` path fails to spawn the hook.
  # The placeholder also tracks INSTALL_DIR renames (we hit this once during
  # the .claude-telegram-agent → pager rename — hooks silently stopped firing).
  sed "s|__HOOKS_DIR__|$HOOKS_DIR|g" "$REPO_DIR/agent/bot-hooks.json" > "$AGENT_DIR/../bot-hooks.json"

  # The poller and its modules have no third-party deps (bun ships what they
  # need), so there's nothing to `bun install`. Still verify bun is present —
  # the agent runtime won't start without it.
  if command -v bun >/dev/null 2>&1; then
    say "Installed agent modules under $AGENT_DIR"
  else
    say "WARN: bun not found on PATH — the agent will not start until bun is installed"
  fi
fi

# ---- 3d. Default catch-all mount + cross-session memory (Phase 4) ----------
# Set up the "any unmounted Telegram topic auto-spawns a claude here" template
# so new users don't have to /mount every topic individually. Reads CLAUDE_CWD
# from the .env we just wrote (or the user's existing one). Idempotent — if a
# wildcard mount already exists, leave it alone (user may have repointed it).
DEFAULT_MOUNT_PATH=$(grep '^CLAUDE_CWD=' "$CONFIG_DIR/.env" 2>/dev/null \
  | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//' | envsubst)
if [[ -n "$DEFAULT_MOUNT_PATH" && -f "$AGENT_DIR/mount-store/mount-store.ts" ]]; then
  mkdir -p "$DEFAULT_MOUNT_PATH"  # create the dir if missing — otherwise mount-store rejects
  existing_wildcard=$(bun run "$AGENT_DIR/mount-store/mount-store.ts" get '*' 2>/dev/null || echo "null")
  if [[ "$existing_wildcard" == "null" || -z "$existing_wildcard" ]]; then
    if bun run "$AGENT_DIR/mount-store/mount-store.ts" add '*' "$DEFAULT_MOUNT_PATH" default >/dev/null 2>&1; then
      say "Wildcard mount → $DEFAULT_MOUNT_PATH (any unmounted topic auto-routes here)"
    fi
  fi
fi

# Cross-session shared memory file. claude reads/appends notes here so context
# survives across topics + project switches. The daemon's system prompt
# tells claude this file exists; nothing on the host writes it automatically.
SHARED_CTX="$CONFIG_DIR/shared-context.md"
if [[ ! -f "$SHARED_CTX" ]]; then
  (umask 077 && cat > "$SHARED_CTX" <<'EOF'
# Cross-session memory

This file is shared across all Telegram topics and claude sessions on this
host. The Telegram bot tells every claude session to read from and append
to this file so durable context (user preferences, ongoing concerns,
decisions) survives across topic switches.

Add entries below. Keep them short. Avoid duplication.

---

EOF
  )
  say "Initialized $SHARED_CTX"
fi

# ---- 3c. Remove the retired bind-telegram-topic skill ----------------------
# P6c: `cta bind` is gone (it was tmux-only), so its slash-command wrapper is
# retired. Clean up any previously-installed copy so stale skills don't linger.
SKILLS_DST="$HOME/.claude/skills/bind-telegram-topic"
if [[ -d "$SKILLS_DST" ]]; then
  rm -rf "$SKILLS_DST"
  say "Removed retired skill bind-telegram-topic"
fi

# ---- 4. Provision Telegram plugin secrets (optional) -----------------------
mkdir -p "$TELEGRAM_DIR"
chmod 700 "$TELEGRAM_DIR"

# Bot token
if [[ -f "$TELEGRAM_ENV" ]] && grep -q '^TELEGRAM_BOT_TOKEN=..*' "$TELEGRAM_ENV"; then
  say "Telegram bot token already present at $TELEGRAM_ENV — skipping"
else
  printf "\nTelegram bot token (from @BotFather), or blank to skip: "
  # -s = silent (don't echo), -r = no backslash processing
  IFS= read -rs TOKEN
  printf "\n"

  if [[ -z "${TOKEN:-}" ]]; then
    # Drop a commented stub so the user can find where to put the token later.
    umask 077
    cat > "$TELEGRAM_ENV" <<'EOF'
# Paste your Telegram bot token from @BotFather on the line below.
# TELEGRAM_BOT_TOKEN=123456789:AA...
EOF
    chmod 600 "$TELEGRAM_ENV"
    say "Token skipped — stub written to $TELEGRAM_ENV (edit when ready)"
  else
    # Sanity: Telegram bot tokens are 8-12 digits, a colon, and 35+ url-safe
    # chars. Same shape check-no-secrets.sh enforces; keep them in sync so a
    # typo can't slip past the installer and then trip the commit hook later.
    if [[ ! "$TOKEN" =~ ^[0-9]{8,12}:[A-Za-z0-9_-]{35,}$ ]]; then
      printf "⚠  Token does not match expected Telegram format — saving anyway\n"
    fi
    umask 077
    printf "TELEGRAM_BOT_TOKEN=%s\n" "$TOKEN" > "$TELEGRAM_ENV"
    chmod 600 "$TELEGRAM_ENV"
    # Mask all but the last 4 characters when echoing back for confirmation.
    masked="****${TOKEN: -4}"
    say "Wrote $TELEGRAM_ENV ($masked, mode 600)"
  fi
fi

# Allowlist
if [[ -f "$TELEGRAM_ACCESS" ]]; then
  say "Telegram access.json already present at $TELEGRAM_ACCESS — skipping"
else
  printf "\nYour Telegram user ID (numeric), or blank to leave the channel open: "
  read -r ALLOW_ID

  if [[ -z "${ALLOW_ID:-}" ]]; then
    printf "⚠  No allowlist configured. ANYONE who finds the bot can DM Claude.\n"
    printf '   Strongly recommend: set ALLOWED_USERS later in %s.\n' "$TELEGRAM_ACCESS"
    cat > "$TELEGRAM_ACCESS" <<'EOF'
{
  "dmPolicy": "open",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
EOF
  else
    if [[ ! "$ALLOW_ID" =~ ^[0-9]+$ ]]; then
      die "Telegram user ID must be numeric (got: $ALLOW_ID)"
    fi
    cat > "$TELEGRAM_ACCESS" <<EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": [
    "$ALLOW_ID"
  ],
  "groups": {},
  "pending": {}
}
EOF
    say "Wrote $TELEGRAM_ACCESS (allowlist: $ALLOW_ID)"
  fi
  chmod 600 "$TELEGRAM_ACCESS"
fi

# ---- 5. Generate and load LaunchAgents --------------------------------------
# Two jobs (P6c, launchd-direct, no tmux):
#   com.claude-agent     → start_agents.sh → exec bun poller.ts
#   com.claude-watchdog  → watch_network.sh (network + heartbeat; kickstarts
#                          the agent job on a stale poller heartbeat)
mkdir -p "$LAUNCH_AGENTS_DIR"
render_plist() {  # <template-basename> <dest-path>
  sed -e "s|__BIN_DIR__|$BIN_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__STATE_DIR__|$STATE_DIR|g" \
      "$REPO_DIR/launchagent/$1" > "$2"
  say "Wrote $2"
}
render_plist "com.claude-agent.plist.template"    "$PLIST_PATH"
render_plist "com.claude-watchdog.plist.template" "$WATCHDOG_PLIST_PATH"

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
say "Loaded LaunchAgent $PLIST_LABEL"

launchctl unload "$WATCHDOG_PLIST_PATH" 2>/dev/null || true
launchctl load "$WATCHDOG_PLIST_PATH"
say "Loaded LaunchAgent $WATCHDOG_LABEL"

# ---- 6. Generate pairing code (Phase 3 zero-config onboarding) -------------
# Generate (or display existing) one-time pairing code so the user can claim
# the bot from Telegram itself — no chat_id editing required.
PAIRING_CODE=$("$BIN_DIR/cta" pair-code --init 2>/dev/null || echo "")

# ---- 7. Done ----------------------------------------------------------------
if [[ -n "$PAIRING_CODE" ]]; then
  cat <<EOF

✓ Installed.

To connect your bot:

  1. (One-time) Open @BotFather in Telegram, send /setprivacy, pick your bot,
     choose "Disable". This lets the bot read all messages in groups you add
     it to (without it, your messages are invisible to the bot in groups).
     DMs work either way.
  2. Add your bot to a chat (DM, group, or forum group).
  3. The bot will immediately reply "Should I pair with this chat?"
     Tap "✓ Yes, pair me here". Only YOU (the inviter) can confirm.
  4. Done. Any message you send in a topic auto-routes to a claude session.

If the auto-prompt doesn't appear (rare, e.g. privacy mode quirks), fall
back to the manual pairing code:

  PAIRING CODE:  $PAIRING_CODE
  In Telegram, send:  /pair $PAIRING_CODE

Default project dir for auto-routed topics: $DEFAULT_MOUNT_PATH
To pin a specific topic to a different dir, send inside that topic:
  /mount ~/path/to/other-project

Useful commands from the host:
  cta init                     — guided setup wizard (re-runnable, resumes where you left off)
  cta status                   — agent health snapshot
  cta pair-code                — re-display the fallback pairing code
  cta pair-code --reset        — invalidate the printed code + regen
  cta list                     — current mounts
  tail -f $CONFIG_DIR/agent.log
EOF
else
  cat <<EOF

✓ Installed (couldn't generate pairing code automatically — run \`cta pair-code --init\` manually).

Tail the agent log:  tail -f $CONFIG_DIR/agent.log
EOF
fi

# ---- 7b. Recommend the host sleep-fix --------------------------------------
# The poller is a CONTINUOUS long-poll: macOS idle-sleep — or, on Apple
# Silicon, standby/powernap maintenance naps — freeze it and the bot goes
# silently quiet. caffeinate is the weak lever (it doesn't stop standby/
# powernap); the real fix is pmset. We do NOT auto-sudo here — install
# shouldn't change system power policy unprompted — we only surface the
# one-liner, and only when the host isn't already hardened.
if ! "$BIN_DIR/cta" config sleep-fix status >/dev/null 2>&1; then
  cat <<EOF

⚠  Keep the bot from going silent when the Mac is idle:

   The poller freezes if macOS idle-sleeps, or (Apple Silicon) enters
   standby/powernap. Harden the host once — needs sudo:

     cta config sleep-fix on      # sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0

   Check anytime: cta status      (see the "Sleep-fix:" line)
   For true 24/7, run the agent on a never-sleep Mac or a Linux host.
EOF
fi

# Optional: chain-install the companion Claude Pager menu bar app. The Pager
# lives at pager/ inside this repo (merged from the old claude-telegram-agent-bar
# repo). Build requires `swift`, so default to "ask" when it's available and
# skip silently when it isn't (e.g. headless installs on machines without
# Xcode Command Line Tools).
WITH_PAGER="${WITH_PAGER:-ask}"
for arg in "$@"; do
  case "$arg" in
    --with-pager) WITH_PAGER=yes ;;
    --no-pager)   WITH_PAGER=no  ;;
  esac
done

if [[ -d "$REPO_DIR/pager" && -f "$REPO_DIR/pager/install.sh" ]]; then
  install_pager=0
  case "$WITH_PAGER" in
    yes) install_pager=1 ;;
    no)  install_pager=0 ;;
    ask)
      if command -v swift >/dev/null 2>&1; then
        printf "\nInstall the Claude Pager menu bar app too? [Y/n] "
        read -r ans
        case "${ans:-y}" in [Nn]*) install_pager=0 ;; *) install_pager=1 ;; esac
      else
        echo
        echo "→ Skipping Claude Pager — swift not on PATH (install Xcode Command Line Tools and re-run with --with-pager)."
      fi
      ;;
  esac
  if [[ "$install_pager" == "1" ]]; then
    if ! command -v swift >/dev/null 2>&1; then
      echo "✗ Pager build requires swift. Install Xcode Command Line Tools and re-run with --with-pager." >&2
    else
      echo
      echo "→ Building + installing Claude Pager from $REPO_DIR/pager"
      "$REPO_DIR/pager/install.sh"
    fi
  fi
fi
