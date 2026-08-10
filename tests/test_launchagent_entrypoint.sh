#!/bin/bash
# Tests for the launchd entrypoint topology (P6c, 2026-05-22).
#
# Two launchd jobs, no terminal multiplexer:
#   com.claude-agent     → start_agents.sh → exec bun poller.ts (KeepAlive on
#                          crash; clean stop leaves it down)
#   com.claude-watchdog  → watch_network.sh (KeepAlive on crash; clean stop
#                          leaves it down; stale heartbeat kickstarts agent)
#
# Validates the plist templates + that install-time sed substitution leaves no
# placeholders behind. Pure file/template assertions — no launchctl side
# effects.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_TPL="$REPO_DIR/launchagent/com.claude-agent.plist.template"
WATCHDOG_TPL="$REPO_DIR/launchagent/com.claude-watchdog.plist.template"

PASS=0
FAIL=0
ok() { echo "  ok  $1";   PASS=$((PASS + 1)); }
ng() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

# ─── both templates exist ────────────────────────────────────────────────────
[[ -f "$AGENT_TPL" ]]    && ok "com.claude-agent template present"    || ng "com.claude-agent template missing"
[[ -f "$WATCHDOG_TPL" ]] && ok "com.claude-watchdog template present" || ng "com.claude-watchdog template missing"

# ─── agent plist: entrypoint + supervision contract ─────────────────────────
agent_body="$(cat "$AGENT_TPL" 2>/dev/null || true)"
[[ "$agent_body" == *"<string>com.claude-agent</string>"* ]] \
  && ok "agent: Label com.claude-agent" || ng "agent: Label com.claude-agent"
[[ "$agent_body" == *"__BIN_DIR__/start_agents.sh"* ]] \
  && ok "agent: ProgramArguments → start_agents.sh" || ng "agent: ProgramArguments → start_agents.sh"
[[ "$agent_body" == *"<key>SuccessfulExit</key>"* && "$agent_body" == *"<key>KeepAlive</key>"* ]] \
  && ok "agent: KeepAlive on unsuccessful exit only" || ng "agent: KeepAlive on unsuccessful exit only"
[[ "$agent_body" == *"__STATE_DIR__/agent.log"* ]] \
  && ok "agent: StandardOutPath → agent.log" || ng "agent: StandardOutPath → agent.log"

# ─── watchdog plist: own job, crash-only supervision ────────────────────────
wd_body="$(cat "$WATCHDOG_TPL" 2>/dev/null || true)"
[[ "$wd_body" == *"<string>com.claude-watchdog</string>"* ]] \
  && ok "watchdog: Label com.claude-watchdog" || ng "watchdog: Label com.claude-watchdog"
[[ "$wd_body" == *"__BIN_DIR__/watch_network.sh"* ]] \
  && ok "watchdog: ProgramArguments → watch_network.sh" || ng "watchdog: ProgramArguments → watch_network.sh"
# Crash-only KeepAlive: clean stop stays stopped; non-zero exit relaunches.
if printf '%s' "$wd_body" | tr -d ' \n' | grep -q '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>'; then
  ok "watchdog: KeepAlive on unsuccessful exit only"
else
  ng "watchdog: expected crash-only KeepAlive (<key>SuccessfulExit</key><false/>)"
fi

# ─── neither plist references a terminal multiplexer ─────────────────────────
if grep -qi '\btmux\b' "$AGENT_TPL" "$WATCHDOG_TPL"; then
  ng "plist templates: still reference tmux"
else
  ok "plist templates: tmux-free"
fi

# ─── install-time sed leaves no placeholders ────────────────────────────────
# Mirror install.sh's substitution and assert all __FOO__ tokens resolve.
for tpl in "$AGENT_TPL" "$WATCHDOG_TPL"; do
  rendered="$(sed -e "s|__BIN_DIR__|/tmp/bin|g" \
                  -e "s|__HOME__|/tmp/home|g" \
                  -e "s|__STATE_DIR__|/tmp/state|g" "$tpl")"
  if printf '%s' "$rendered" | grep -q '__[A-Z_]*__'; then
    ng "$(basename "$tpl"): leftover placeholder after sed ($(printf '%s' "$rendered" | grep -o '__[A-Z_]*__' | sort -u | tr '\n' ' '))"
  else
    ok "$(basename "$tpl"): all placeholders substituted"
  fi
done

# ─── summary ─────────────────────────────────────────────────────────────────
echo
echo "launchagent entrypoint: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
