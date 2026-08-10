#!/bin/bash
# Tests for cli/cta.
#
# Strategy: source cta (BASH_SOURCE guard skips main), override the data-source
# helpers (_la_loaded, _claude_ps_line, etc.) with stubs, then call cmd_status
# and assert against the captured output. Pure-function helpers (_json_*) are
# tested directly.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../cli/cta
source "$SCRIPT_DIR/cli/cta"

PASS=0
FAIL=0
ok() { echo "  ok  $1";   PASS=$((PASS + 1)); }
ng() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

# ─── _json_int_or_null ───────────────────────────────────────────────────────

[[ "$(_json_int_or_null "")"     == "null" ]] && ok "_json_int_or_null: empty → null"     || ng "_json_int_or_null: empty → null"
[[ "$(_json_int_or_null "0")"    == "0"    ]] && ok "_json_int_or_null: 0 → 0 (not null)" || ng "_json_int_or_null: 0 → 0 (not null)"
[[ "$(_json_int_or_null "1234")" == "1234" ]] && ok "_json_int_or_null: 1234 → 1234"      || ng "_json_int_or_null: 1234 → 1234"

# ─── _json_str_or_null ───────────────────────────────────────────────────────

[[ "$(_json_str_or_null "")"        == "null"        ]] && ok "_json_str_or_null: empty → null"            || ng "_json_str_or_null: empty → null"
[[ "$(_json_str_or_null "hello")"   == '"hello"'     ]] && ok "_json_str_or_null: hello → quoted"          || ng "_json_str_or_null: hello → quoted"
[[ "$(_json_str_or_null 'a"b')"     == '"a\"b"'      ]] && ok "_json_str_or_null: escapes double-quote"    || ng "_json_str_or_null: escapes double-quote"
[[ "$(_json_str_or_null 'a\b')"     == '"a\\b"'      ]] && ok "_json_str_or_null: escapes backslash"       || ng "_json_str_or_null: escapes backslash"

# ─── cmd_status (json) — all alive ───────────────────────────────────────────

# Stub every data source. cta's cmd_status calls these directly, so overriding
# the function is enough — no need to mock launchctl/ps/tmux/stat themselves.
_la_loaded()         { return 0; }
_claude_ps_line()    { echo "12345 524288"; }   # PID=12345, RSS=524288 KB = 512 MB
_mcp_alive()         { return 0; }
_poller_alive()      { return 0; }
_watchdog_alive()    { return 0; }
_last_activity()     { echo "2026-05-12T10:00:00Z"; }

TMUX_SESSION_CLAUDE="claude"
TMUX_SESSION_WATCHDOG="watchdog"

JSON=$(cmd_status json)

# Validate JSON is parseable. python3 ships on macOS by default.
if echo "$JSON" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  ok "cmd_status json: produces valid JSON"
else
  ng "cmd_status json: produces valid JSON"
  echo "---- OUTPUT ----"
  echo "$JSON"
  echo "----------------"
fi

# Spot-check key fields.
echo "$JSON" | grep -q '"schema_version": 1'              && ok "json: schema_version=1"             || ng "json: schema_version=1"
echo "$JSON" | grep -q '"pid": 12345'                     && ok "json: pid=12345"                    || ng "json: pid=12345"
echo "$JSON" | grep -q '"rss_mb": 512'                    && ok "json: rss_mb=512 (KB → MB)"         || ng "json: rss_mb=512 (KB → MB)"
echo "$JSON" | grep -q '"loaded": true'                   && ok "json: launch_agent.loaded=true"     || ng "json: launch_agent.loaded=true"
echo "$JSON" | grep -q '"telegram_mcp": {"alive": true}'  && ok "json: telegram_mcp.alive=true"      || ng "json: telegram_mcp.alive=true"
echo "$JSON" | grep -q '"last_activity": "2026-05-12T10:00:00Z"' && ok "json: last_activity present" || ng "json: last_activity present"

# ─── cmd_status (json) — everything dead ─────────────────────────────────────

_la_loaded()         { return 1; }
_claude_ps_line()    { echo ""; }
_mcp_alive()         { return 1; }
_poller_alive()      { return 1; }
_watchdog_alive()    { return 1; }
_last_activity()     { echo ""; }

JSON=$(cmd_status json)
echo "$JSON" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 \
  && ok "cmd_status json (down): valid JSON" || ng "cmd_status json (down): valid JSON"
echo "$JSON" | grep -q '"loaded": false'      && ok "json (down): launch_agent.loaded=false" || ng "json (down): launch_agent.loaded=false"
echo "$JSON" | grep -q '"pid": null'          && ok "json (down): pid=null"                  || ng "json (down): pid=null"
echo "$JSON" | grep -q '"rss_mb": null'       && ok "json (down): rss_mb=null"               || ng "json (down): rss_mb=null"
echo "$JSON" | grep -q '"last_activity": null' && ok "json (down): last_activity=null"       || ng "json (down): last_activity=null"

# ─── tmux session name comes from .env (the dual-repo bug we fixed) ──────────

# Simulate a user who renamed their tmux sessions in .env. This covers single-
# topic v0 mode; the MULTI_TOPIC override below covers Phase-1.
MULTI_TOPIC=0
TMUX_SESSION_CLAUDE="my-bot"
TMUX_SESSION_WATCHDOG="my-watchdog"
_poller_alive()   { return 0; }
_watchdog_alive() { return 0; }
JSON=$(cmd_status json)
echo "$JSON" | grep -q '"name": "my-bot"'      && ok "json: respects custom claude session name"   || ng "json: respects custom claude session name"
echo "$JSON" | grep -q '"name": "my-watchdog"' && ok "json: respects custom watchdog session name" || ng "json: respects custom watchdog session name"

# MULTI_TOPIC=1: tmux.claude.name should become 'poller' regardless of
# TMUX_SESSION_CLAUDE, because the v0 control session doesn't exist in
# Phase-1 mode and Pager would otherwise report claude=✗ forever.
MULTI_TOPIC=1
JSON=$(cmd_status json)
echo "$JSON" | grep -q '"name": "poller"'      && ok "json (MULTI_TOPIC): tmux.claude → poller"  || ng "json (MULTI_TOPIC): tmux.claude → poller"
echo "$JSON" | grep -q '"name": "my-watchdog"' && ok "json (MULTI_TOPIC): watchdog name preserved" || ng "json (MULTI_TOPIC): watchdog name preserved"
MULTI_TOPIC=0

# ─── cmd_status (text) — runs without error ──────────────────────────────────

# Restore an alive state and verify text format works at all. We don't pin
# the exact text shape since it's for human eyes.
_la_loaded() { return 0; }
_claude_ps_line() { echo "999 102400"; }
TMUX_SESSION_CLAUDE="claude"
TMUX_SESSION_WATCHDOG="watchdog"

TEXT=$(cmd_status text)
echo "$TEXT" | grep -q "claude PID:.*999" && ok "cmd_status text: shows pid" || ng "cmd_status text: shows pid"
echo "$TEXT" | grep -q "MB"                && ok "cmd_status text: shows RSS in MB" || ng "cmd_status text: shows RSS in MB"

# ─── cmd_start: idempotent, non-destructive launchd load ─────────────────────
# Regression (v0.1.0): Pager's ensureBotRunning() calls `cta start` on every
# launch. The old path ran start_agents.sh, which killed + respawned the tmux
# sessions, taking the live bot offline for ~3s and churning the claude PID.
#
# P6c contract: `cta start` loads BOTH LaunchAgents (com.claude-agent +
# com.claude-watchdog). Loading an already-loaded job is a no-op, and a healthy
# (alive) poller is never kickstarted — so the call is fully non-destructive.
# Only a DOWN poller gets a `launchctl kickstart` to bring it up. It must NEVER
# bootout/unload/kickstart -k a running poller.

LAUNCHCTL_LOG=$(mktemp)
launchctl() { echo "$*" >> "$LAUNCHCTL_LOG"; return 0; }

# Real temp files so cmd_start's [[ -f ]] plist guards pass.
AGENT_PLIST=$(mktemp)
WATCHDOG_PLIST=$(mktemp)
PLIST_PATH="$AGENT_PLIST"
WATCHDOG_PLIST_PATH="$WATCHDOG_PLIST"

# Case 1: poller already alive → load both, but do NOT touch a healthy poller.
: > "$LAUNCHCTL_LOG"
_poller_alive()   { return 0; }
_watchdog_alive() { return 0; }
cmd_start >/dev/null
calls=$(cat "$LAUNCHCTL_LOG")
if grep -q "^load .*$AGENT_PLIST" <<<"$calls" && grep -q "^load .*$WATCHDOG_PLIST" <<<"$calls"; then
  ok "cmd_start: loads both LaunchAgents"
else
  ng "cmd_start: should load both plists (got: $(tr '\n' ';' <<<"$calls"))"
fi
if grep -Eq "bootout|unload|kickstart -k" <<<"$calls"; then
  ng "cmd_start (poller alive): MUST NOT bootout/unload/kickstart -k (got: $(tr '\n' ';' <<<"$calls"))"
else
  ok "cmd_start (poller alive): non-destructive (no bootout/unload/kickstart -k)"
fi
if grep -q "kickstart gui/.*$PLIST_LABEL" <<<"$calls"; then
  ng "cmd_start (poller alive): should NOT kickstart a healthy poller (got: $(tr '\n' ';' <<<"$calls"))"
else
  ok "cmd_start (poller alive): skips kickstart of healthy poller"
fi

# Case 2: poller down → load + kickstart the agent job to bring it up.
: > "$LAUNCHCTL_LOG"
_poller_alive()   { return 1; }
_watchdog_alive() { return 1; }
cmd_start >/dev/null
calls=$(cat "$LAUNCHCTL_LOG")
if grep -Eq "kickstart gui/[0-9]+/$PLIST_LABEL" <<<"$calls"; then
  ok "cmd_start (poller down): kickstarts the agent job"
else
  ng "cmd_start (poller down): expected 'kickstart gui/<uid>/$PLIST_LABEL' (got: $(tr '\n' ';' <<<"$calls"))"
fi

# Case 3: watchdog plist missing (e.g. upgrade without re-running install.sh).
# cmd_start must WARN on the missing plist instead of silently reporting health
# while hang-recovery supervision is absent (codex P2, 2026-05-22).
: > "$LAUNCHCTL_LOG"
_poller_alive()   { return 0; }
_watchdog_alive() { return 0; }
WATCHDOG_PLIST_PATH="/nonexistent/com.claude-watchdog.plist"
START_WARN=$(cmd_start 2>&1 >/dev/null)
if grep -qiE "watchdog|com.claude-watchdog" <<<"$START_WARN"; then
  ok "cmd_start (watchdog plist missing): warns about the missing plist"
else
  ng "cmd_start (watchdog plist missing): expected a stderr warning (got: '$START_WARN')"
fi

rm -f "$LAUNCHCTL_LOG" "$AGENT_PLIST" "$WATCHDOG_PLIST"
unset -f _poller_alive _watchdog_alive launchctl 2>/dev/null

# ─── cmd_stop bun cleanup (regression: orphan bun → double-poller race) ─────
# Regression: v0.1.1 — cta stop killed the tmux session but left the bun MCP
# grandchildren that the official telegram plugin spawned. They reparented to
# launchd and kept long-polling Telegram's getUpdates. The next cta start
# spawned a fresh bun → two consumers raced for getUpdates → ~half of inbound
# messages went to the orphan (no claude listening) and were silently dropped.
# Found by /qa on 2026-05-12 when the user observed "no response" after a bot
# restart cycle.
#
# Contract: cmd_stop targets ONLY the plugin's own bun processes — identified
# by `pgrep -f "claude-plugins-official.*telegram.*start"` for the wrapper,
# then `pgrep -P <wrapper-pid>` for the bun server.ts child. Never kills an
# unrelated `bun server.ts` the user might run in a different project.

# cmd_stop calls pgrep + kill inside `$(...)` subshells, so we can't capture
# their args into a parent-shell array. Use tempfiles instead — every call
# appends a line, and the parent reads the file after cmd_stop returns.
PGREP_LOG=$(mktemp)
KILL_LOG=$(mktemp)

pgrep() {
  echo "$*" >> "$PGREP_LOG"
  case "$*" in
    *"-f"*"claude-plugins-official"*) echo "1001" ;;   # wrapper PID
    *"-P 1001"*)                       echo "1002" ;;   # bun server.ts child
    *)                                  return 1 ;;     # nothing else matches
  esac
}
kill() {
  echo "$*" >> "$KILL_LOG"
  return 0
}
tmux() { return 0; }
launchctl() { return 0; }

# Plist paths don't exist so the launchctl-unload branch's if-guard returns
# false. Same shape as a fresh install before install.sh has written the plists.
PLIST_PATH="/nonexistent/com.claude-agent.plist"
WATCHDOG_PLIST_PATH="/nonexistent/com.claude-watchdog.plist"

cmd_stop >/dev/null

# Were the right kills issued? Both wrapper and child should appear.
all_kills=$(cat "$KILL_LOG" 2>/dev/null | tr '\n' ' ')
if [[ "$all_kills" == *"1002"* ]]; then
  ok "cmd_stop: killed plugin bun server (PID 1002)"
else
  ng "cmd_stop: did NOT kill plugin bun server (got: $all_kills)"
fi
if [[ "$all_kills" == *"1001"* ]]; then
  ok "cmd_stop: killed plugin wrapper (PID 1001)"
else
  ng "cmd_stop: did NOT kill plugin wrapper (got: $all_kills)"
fi

# Was the plugin pattern actually searched for?
all_pgrep=$(cat "$PGREP_LOG" 2>/dev/null | tr '\n' ' ')
if [[ "$all_pgrep" == *"claude-plugins-official"* ]]; then
  ok "cmd_stop: pgrep'd for plugin-specific pattern"
else
  ng "cmd_stop: did NOT pgrep for plugin-specific pattern (got: $all_pgrep)"
fi

# Negative test: cmd_stop must NOT have searched for a generic 'bun.*server.ts'
# pattern. That would over-match user's unrelated bun projects.
if [[ "$all_pgrep" == *"bun.*server"* || "$all_pgrep" == *"bun .*server"* ]]; then
  ng "cmd_stop: SHOULD NOT pgrep for generic 'bun server.ts' (got: $all_pgrep)"
else
  ok "cmd_stop: correctly avoided generic 'bun server.ts' pattern"
fi

rm -f "$PGREP_LOG" "$KILL_LOG"
unset -f pgrep kill tmux launchctl 2>/dev/null

# ─── PATH augmentation (regression: launchd-spawned callers) ─────────────────
# Regression: v0.1.0 — Pager's diagnostic showed tmux=✗ even when sessions
# were alive. Found by /qa on 2026-05-12. Root cause: launchd strips PATH
# to /usr/bin:/bin:/usr/sbin:/sbin, and tmux lives in /opt/homebrew/bin.
# cta's `tmux has-session` call silently failed with "command not found".
# Fix: cta prepends $HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin and
# appends $HOME/.local/bin so child commands resolve under stripped PATH.
#
# Test approach: run cta in a forked shell with the launchd-stripped PATH,
# then check the script's effective PATH includes the homebrew locations.
# We don't need real tmux — just need to verify cta would find it if it
# existed in the canonical locations.

EFFECTIVE_PATH=$(env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  bash -c "source '$SCRIPT_DIR/cli/cta' >/dev/null 2>&1; echo \$PATH")

if [[ "$EFFECTIVE_PATH" == *"/opt/homebrew/bin"* ]]; then
  ok "cta prepends /opt/homebrew/bin under stripped launchd PATH"
else
  ng "cta prepends /opt/homebrew/bin under stripped launchd PATH (got: $EFFECTIVE_PATH)"
fi

if [[ "$EFFECTIVE_PATH" == *"/usr/local/bin"* ]]; then
  ok "cta prepends /usr/local/bin under stripped launchd PATH"
else
  ng "cta prepends /usr/local/bin under stripped launchd PATH (got: $EFFECTIVE_PATH)"
fi

# When PATH is unset entirely (some launchd edge cases), the fallback
# /usr/bin:/bin must kick in so basic posix tools still resolve.
EFFECTIVE_PATH_UNSET=$(env -i HOME="$HOME" \
  bash -c "source '$SCRIPT_DIR/cli/cta' >/dev/null 2>&1; echo \$PATH")
if [[ "$EFFECTIVE_PATH_UNSET" == *"/usr/bin"* && "$EFFECTIVE_PATH_UNSET" == *"/bin"* ]]; then
  ok "cta provides /usr/bin:/bin fallback when PATH is unset"
else
  ng "cta provides /usr/bin:/bin fallback when PATH is unset (got: $EFFECTIVE_PATH_UNSET)"
fi

# ─── cmd_config ack: on/off round-trip ────────────────────────────────────────
#
# `cta config ack on` writes ackReaction=<default emoji> to access.json,
# `off` removes the key. Plugin reads access.json per request so the change is
# live without a bot restart. Test uses a tmp ACCESS_FILE — no risk of
# clobbering the real config.

CFG_TMP=$(mktemp -d)
ACCESS_FILE="$CFG_TMP/access.json"
cat > "$ACCESS_FILE" <<'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["123"],
  "groups": {},
  "pending": {}
}
EOF

# on → key present with the default emoji
cmd_config ack on >/dev/null 2>&1
ACK_AFTER_ON=$(python3 -c "import json; print(json.load(open('$ACCESS_FILE')).get('ackReaction',''))" 2>/dev/null)
[[ "$ACK_AFTER_ON" == "$DEFAULT_ACK_EMOJI" ]] \
  && ok "cmd_config ack on: writes default emoji" \
  || ng "cmd_config ack on: expected $DEFAULT_ACK_EMOJI, got '$ACK_AFTER_ON'"

# on must not touch the allowlist or dmPolicy
KEEP_ALLOW=$(python3 -c "import json; print(','.join(json.load(open('$ACCESS_FILE'))['allowFrom']))" 2>/dev/null)
[[ "$KEEP_ALLOW" == "123" ]] \
  && ok "cmd_config ack on: preserves allowFrom" \
  || ng "cmd_config ack on: lost allowFrom (got '$KEEP_ALLOW')"

# off → key removed entirely (not just set to empty string)
cmd_config ack off >/dev/null 2>&1
HAS_KEY=$(python3 -c "import json; print('ackReaction' in json.load(open('$ACCESS_FILE')))" 2>/dev/null)
[[ "$HAS_KEY" == "False" ]] \
  && ok "cmd_config ack off: removes the key entirely" \
  || ng "cmd_config ack off: key still present (got '$HAS_KEY')"

# Invalid value rejected without mutating the file.
cmd_config ack maybe >/dev/null 2>&1 && ng "cmd_config ack maybe: should exit non-zero" \
  || ok "cmd_config ack maybe: rejected with non-zero exit"

# Missing access.json → helpful error, non-zero exit, no python traceback.
rm -f "$ACCESS_FILE"
ERR=$(cmd_config ack on 2>&1)
RC=$?
[[ "$RC" -ne 0 && "$ERR" == *"Missing"* ]] \
  && ok "cmd_config ack on: missing access.json reports cleanly" \
  || ng "cmd_config ack on: missing-file error (rc=$RC, msg='$ERR')"

# ─── cmd_config idle-evict: threshold round-trip ───────────────────────────────
#
# `cta config idle-evict <min>` writes idle_evict_minutes to $STATE_DIR/settings.json
# (version 1); `0` disables; no-arg prints the current value; invalid input is
# rejected. The poller live-reloads settings.json so changes are restart-free.
# Tmp STATE_DIR/SETTINGS_FILE — no risk to the real config.

IE_TMP=$(mktemp -d)
STATE_DIR="$IE_TMP"
SETTINGS_FILE="$IE_TMP/settings.json"

# set 30 → idle_evict_minutes present + version stamped
cmd_config idle-evict 30 >/dev/null 2>&1
IE_AFTER=$(python3 -c "import json; d=json.load(open('$SETTINGS_FILE')); print(d.get('idle_evict_minutes'), d.get('version'))" 2>/dev/null)
[[ "$IE_AFTER" == "30 1" ]] \
  && ok "cmd_config idle-evict 30: writes idle_evict_minutes + version" \
  || ng "cmd_config idle-evict 30: expected '30 1', got '$IE_AFTER'"

# file written restrictively (mode 600), like the other state files
IE_MODE=$(stat -f '%Lp' "$SETTINGS_FILE" 2>/dev/null || stat -c '%a' "$SETTINGS_FILE" 2>/dev/null)
[[ "$IE_MODE" == "600" ]] \
  && ok "cmd_config idle-evict: settings.json is mode 600" \
  || ng "cmd_config idle-evict: expected mode 600, got '$IE_MODE'"

# no-arg → prints the current value
IE_SHOW=$(cmd_config idle-evict 2>/dev/null)
[[ "$IE_SHOW" == "30" ]] \
  && ok "cmd_config idle-evict (no arg): prints current value" \
  || ng "cmd_config idle-evict (no arg): expected 30, got '$IE_SHOW'"

# merge must preserve unrelated keys (mirrors the ack merge contract)
python3 -c "import json; d=json.load(open('$SETTINGS_FILE')); d['keep_me']='x'; json.dump(d, open('$SETTINGS_FILE','w'))"
cmd_config idle-evict 45 >/dev/null 2>&1
IE_KEEP=$(python3 -c "import json; d=json.load(open('$SETTINGS_FILE')); print(d.get('idle_evict_minutes'), d.get('keep_me'))" 2>/dev/null)
[[ "$IE_KEEP" == "45 x" ]] \
  && ok "cmd_config idle-evict: merge preserves unrelated keys" \
  || ng "cmd_config idle-evict: lost unrelated key (got '$IE_KEEP')"

# 0 → disables (persisted as 0, reads back 0)
cmd_config idle-evict 0 >/dev/null 2>&1
IE_OFF=$(cmd_config idle-evict 2>/dev/null)
[[ "$IE_OFF" == "0" ]] \
  && ok "cmd_config idle-evict 0: disables (reads back 0)" \
  || ng "cmd_config idle-evict 0: expected 0, got '$IE_OFF'"

# invalid → non-zero exit
cmd_config idle-evict abc >/dev/null 2>&1 && ng "cmd_config idle-evict abc: should exit non-zero" \
  || ok "cmd_config idle-evict abc: rejected with non-zero exit"

# no-arg with missing file → prints recommended default 15, no traceback
rm -f "$SETTINGS_FILE"
IE_MISSING=$(cmd_config idle-evict 2>/dev/null)
[[ "$IE_MISSING" == "15" ]] \
  && ok "cmd_config idle-evict (no arg, missing file): prints 15" \
  || ng "cmd_config idle-evict (no arg, missing file): expected 15, got '$IE_MISSING'"
rm -rf "$IE_TMP"

rm -rf "$CFG_TMP"

# ─── _caffeinate_alive: PID-file liveness check ──────────────────────────────
#
# Pure liveness test. No file → not alive. File with bogus PID → not alive.
# File with our own $$ → alive (we're running, by definition).

CAFFEINATE_PID_FILE=$(mktemp -u)   # path, not file — start absent

! _caffeinate_alive && ok "_caffeinate_alive: missing file → not alive" \
                    || ng "_caffeinate_alive: missing file should be not-alive"

# Bogus PID — pick something unlikely to exist. PIDs > 99999 are
# vanishingly rare on macOS in normal sessions.
echo "999999" > "$CAFFEINATE_PID_FILE"
! _caffeinate_alive && ok "_caffeinate_alive: stale PID → not alive" \
                    || ng "_caffeinate_alive: PID 999999 should be not-alive"

# Use our own PID — guaranteed alive while this test runs.
echo "$$" > "$CAFFEINATE_PID_FILE"
_caffeinate_alive && ok "_caffeinate_alive: live PID (self) → alive" \
                  || ng "_caffeinate_alive: own PID $$ should be alive"

# Empty PID file (zero bytes) is a degenerate state we should handle, not
# crash on. A `kill -0 ""` would error noisily; the helper must treat it as
# "not alive" cleanly.
: > "$CAFFEINATE_PID_FILE"
! _caffeinate_alive && ok "_caffeinate_alive: empty file → not alive" \
                    || ng "_caffeinate_alive: empty file should be not-alive"

rm -f "$CAFFEINATE_PID_FILE"

# ─── _caffeinate_start: lock serializes concurrent starts (no orphan leak) ───
#
# Regression guard for the caffeinate-orphan leak. Pager's CaffeinateController
# fires `cta config caffeinate on` from unserialized tasks on every power-state
# change; without a lock two concurrent _caffeinate_start calls both pass
# _caffeinate_alive before either writes the pid file, both spawn, and the loser
# orphans (ppid 1). _caffeinate_start now takes an atomic mkdir lock around the
# check-and-spawn. CAFFEINATE_BIN injects a stub so we never touch the real one.

CAFF_TMP=$(mktemp -d)
CAFFEINATE_PID_FILE="$CAFF_TMP/caffeinate.pid"
SPAWN_LOG="$CAFF_TMP/spawns"
cat > "$CAFF_TMP/fake-caffeinate" <<EOF
#!/bin/bash
echo spawn >> "$SPAWN_LOG"
exec sleep 300
EOF
chmod +x "$CAFF_TMP/fake-caffeinate"
export CAFFEINATE_BIN="$CAFF_TMP/fake-caffeinate"

# (a) lock free → spawns exactly once + releases the lock.
: > "$SPAWN_LOG"
_caffeinate_start >/dev/null 2>&1
# Wait (bounded) for the backgrounded stub to record its spawn — a fixed sleep
# flakes under load (the stub is `nohup … &`, so the write is async).
for ((w = 0; w < 50; w++)); do [[ -s "$SPAWN_LOG" ]] && break; sleep 0.1; done
CAFF_SPAWNS=$(wc -l < "$SPAWN_LOG" | tr -d ' ')
[[ "$CAFF_SPAWNS" == "1" ]] && ok "_caffeinate_start: spawns once when lock free" \
                            || ng "_caffeinate_start: expected 1 spawn, got $CAFF_SPAWNS"
[[ ! -d "$CAFFEINATE_PID_FILE.lock" ]] && ok "_caffeinate_start: releases lock on success" \
                                       || ng "_caffeinate_start: lock dir leaked"
CAFF_PID=$(cat "$CAFFEINATE_PID_FILE" 2>/dev/null)

# (b) already alive → idempotent, no respawn.
: > "$SPAWN_LOG"
_caffeinate_start >/dev/null 2>&1
CAFF_SPAWNS=$(wc -l < "$SPAWN_LOG" | tr -d ' ')
[[ "$CAFF_SPAWNS" == "0" ]] && ok "_caffeinate_start: idempotent when already alive" \
                            || ng "_caffeinate_start: respawned despite alive ($CAFF_SPAWNS)"

# (c) lock already held (simulated concurrent caller) → must NOT double-spawn.
kill "$CAFF_PID" 2>/dev/null; rm -f "$CAFFEINATE_PID_FILE"
mkdir -p "$CAFFEINATE_PID_FILE.lock"
: > "$SPAWN_LOG"
CAFFEINATE_LOCK_TRIES=2 _caffeinate_start >/dev/null 2>&1
CAFF_SPAWNS=$(wc -l < "$SPAWN_LOG" | tr -d ' ')
[[ "$CAFF_SPAWNS" == "0" ]] && ok "_caffeinate_start: lock held → no double-spawn" \
                            || ng "_caffeinate_start: spawned while lock held ($CAFF_SPAWNS)"
rmdir "$CAFFEINATE_PID_FILE.lock" 2>/dev/null

# Cleanup: kill any stub still alive, drop the seam + temp.
[[ -n "$CAFF_PID" ]] && kill "$CAFF_PID" 2>/dev/null
[[ -f "$CAFFEINATE_PID_FILE" ]] && kill "$(cat "$CAFFEINATE_PID_FILE" 2>/dev/null)" 2>/dev/null
unset CAFFEINATE_BIN CAFFEINATE_LOCK_TRIES
rm -rf "$CAFF_TMP"

# ─── _config_caffeinate: arg validation ──────────────────────────────────────
#
# Don't actually spawn caffeinate in the test — that would race with the
# user's real one if they have it on. Override the start/stop helpers with
# stubs that record what was called.

CAFFEINATE_CALLS=""
_caffeinate_start() { CAFFEINATE_CALLS+="start;"; }
_caffeinate_stop()  { CAFFEINATE_CALLS+="stop;";  }

CAFFEINATE_CALLS=""
_config_caffeinate on >/dev/null 2>&1
[[ "$CAFFEINATE_CALLS" == "start;" ]] \
  && ok "_config_caffeinate on: calls _caffeinate_start" \
  || ng "_config_caffeinate on: expected 'start;', got '$CAFFEINATE_CALLS'"

CAFFEINATE_CALLS=""
_config_caffeinate off >/dev/null 2>&1
[[ "$CAFFEINATE_CALLS" == "stop;" ]] \
  && ok "_config_caffeinate off: calls _caffeinate_stop" \
  || ng "_config_caffeinate off: expected 'stop;', got '$CAFFEINATE_CALLS'"

# Bad arg → non-zero exit, no spawn.
CAFFEINATE_CALLS=""
_config_caffeinate banana >/dev/null 2>&1 && ng "_config_caffeinate banana: should exit non-zero" \
                                          || ok "_config_caffeinate banana: rejected"
[[ -z "$CAFFEINATE_CALLS" ]] \
  && ok "_config_caffeinate banana: did not spawn" \
  || ng "_config_caffeinate banana: leaked a call ('$CAFFEINATE_CALLS')"

# Missing arg → usage error, non-zero exit.
CAFFEINATE_CALLS=""
_config_caffeinate "" >/dev/null 2>&1 && ng "_config_caffeinate (empty): should exit non-zero" \
                                      || ok "_config_caffeinate (empty): rejected"

# ─── _caffeinate_external_pid: detect untracked caffeinates by argv flags ───
#
# When something OUTSIDE cta is holding a system-sleep assertion (Claude Code
# bash-spawned caffeinates, third-party tooling), status should surface that
# so users aren't confused by "Caffeinate: false" while the Mac stays awake.
# Helper walks `pgrep -x caffeinate` and checks each argv for an awake-holding
# flag (-i, -s, -m, -u); -d (display-only) is excluded.

CAFFEINATE_PID_FILE=$(mktemp -u)   # no pidfile = no cta-tracked process

# Case A: a `caffeinate -i` exists → return that PID.
pgrep() { [[ "$1" == "-x" && "$2" == "caffeinate" ]] && echo "12345"; }
ps()    { [[ "$3" == "-p" && "$4" == "12345" ]] && echo "caffeinate -i"; }
[[ "$(_caffeinate_external_pid)" == "12345" ]] \
  && ok "_caffeinate_external_pid: caffeinate -i detected" \
  || ng "_caffeinate_external_pid: caffeinate -i not detected"

# Case B: a `caffeinate -d` (display-only) is NOT awake-holding → skip.
pgrep() { [[ "$1" == "-x" && "$2" == "caffeinate" ]] && echo "12345"; }
ps()    { [[ "$3" == "-p" && "$4" == "12345" ]] && echo "caffeinate -d"; }
! _caffeinate_external_pid >/dev/null \
  && ok "_caffeinate_external_pid: display-only -d ignored" \
  || ng "_caffeinate_external_pid: -d should be ignored"

# Case C: timed -i with -t still counts (the most common Claude Code variant).
pgrep() { [[ "$1" == "-x" && "$2" == "caffeinate" ]] && echo "67890"; }
ps()    { [[ "$3" == "-p" && "$4" == "67890" ]] && echo "caffeinate -i -t 300"; }
[[ "$(_caffeinate_external_pid)" == "67890" ]] \
  && ok "_caffeinate_external_pid: -i -t 300 (timed) detected" \
  || ng "_caffeinate_external_pid: timed -i not detected"

# Case D: the tracked PID is filtered out (we're asking for *external* only).
CAFFEINATE_PID_FILE=$(mktemp)
echo "12345" > "$CAFFEINATE_PID_FILE"
pgrep() { [[ "$1" == "-x" && "$2" == "caffeinate" ]] && echo "12345"; }
ps()    { [[ "$3" == "-p" && "$4" == "12345" ]] && echo "caffeinate -i"; }
! _caffeinate_external_pid >/dev/null \
  && ok "_caffeinate_external_pid: tracked PID filtered out" \
  || ng "_caffeinate_external_pid: tracked PID should be excluded"
rm -f "$CAFFEINATE_PID_FILE"

unset -f pgrep ps

# ─── cmd_status: caffeinate field exposed in JSON ────────────────────────────
#
# Re-run cmd_status with caffeinate "alive" via stubbed PID file and confirm
# the JSON output advertises it. Lock the schema contract so future Pager (or
# any other UI) can rely on the field's presence.

# Earlier blocks `unset -f _tmux_session_alive launchctl` to test the
# stripped-PATH path. Re-stub the data sources cmd_status needs so it can
# run cleanly here.
_la_loaded()          { return 0; }
_claude_ps_line()     { echo ""; }
_mcp_alive()          { return 1; }
_poller_alive()       { return 1; }
_watchdog_alive()     { return 1; }
_last_activity()      { echo ""; }

CAFFEINATE_PID_FILE=$(mktemp)
echo "$$" > "$CAFFEINATE_PID_FILE"
# cta-managed alive — external detection should not fire (and `external_pid`
# should be null) regardless of what else is on the system, because we early-
# return before the pgrep walk.
JSON_CAFF=$(cmd_status json)
echo "$JSON_CAFF" | python3 -c '
import json, sys
data = json.load(sys.stdin)
caff = data["caffeinate"]
assert caff["alive"] is True, "alive should be True, got " + repr(caff)
assert isinstance(caff["pid"], int), "pid should be int, got " + repr(caff["pid"])
assert caff["external_pid"] is None, "external_pid should be null when cta-managed alive, got " + repr(caff)
' \
  && ok "cmd_status json: caffeinate.alive=true + external_pid=null" \
  || ng "cmd_status json: caffeinate field missing or malformed"

rm -f "$CAFFEINATE_PID_FILE"
# cta-managed dead + no external — both pid and external_pid null.
# Stub _caffeinate_external_pid to "" so we don't depend on the host having
# (or not having) some other caffeinate running concurrently with the test.
_caffeinate_external_pid() { return 1; }
JSON_NOCAFF=$(cmd_status json)
echo "$JSON_NOCAFF" | python3 -c '
import json, sys
data = json.load(sys.stdin)
caff = data["caffeinate"]
assert caff["alive"] is False, "alive should be False, got " + repr(caff)
assert caff["pid"] is None, "pid should be null, got " + repr(caff["pid"])
assert caff["external_pid"] is None, "external_pid should be null when nothing detected, got " + repr(caff)
' \
  && ok "cmd_status json: caffeinate=off + external_pid=null" \
  || ng "cmd_status json: caffeinate=off state wrong"

# cta-managed dead + external present — external_pid carries the foreign PID.
_caffeinate_external_pid() { echo 99999; return 0; }
JSON_EXT=$(cmd_status json)
echo "$JSON_EXT" | python3 -c '
import json, sys
data = json.load(sys.stdin)
caff = data["caffeinate"]
assert caff["alive"] is False, "alive should be False, got " + repr(caff)
assert caff["pid"] is None, "pid should be null, got " + repr(caff["pid"])
assert caff["external_pid"] == 99999, "external_pid should surface the foreign PID, got " + repr(caff)
' \
  && ok "cmd_status json: external caffeinate surfaced as external_pid" \
  || ng "cmd_status json: external_pid not surfaced"

# Text output: external should be mentioned so users aren't confused by
# "Caffeinate: false" while the Mac is being kept awake by something else.
TXT_EXT=$(cmd_status 2>/dev/null)
echo "$TXT_EXT" | grep -q "external pid 99999" \
  && ok "cmd_status text: external pid annotated on 'false' line" \
  || ng "cmd_status text: external pid not annotated (got: $TXT_EXT)"

# Restore a no-op (returns "nothing detected") so later cmd_status tests don't
# hit "command not found" — leaving the real pgrep/ps walk in place here would
# make later assertions flaky on hosts that happen to have a caffeinate up.
_caffeinate_external_pid() { return 1; }

# ─── cmd_status: file_access field (FDA probe, surfaced from the poller) ──────
# The poller (launchd TCC context) writes $STATE_DIR/file-access.json; cta status
# surfaces it as an additive field. Absent file → null (back-compat: older agents
# don't write it). Field is read straight from disk — cta itself is the wrong TCC
# context to probe, so it must NOT re-probe.
FA_TMP=$(mktemp -d)
STATE_DIR="$FA_TMP"
_la_loaded()      { return 0; }
_claude_ps_line() { echo ""; }
_mcp_alive()      { return 1; }
_poller_alive()   { return 1; }
_watchdog_alive() { return 1; }
_last_activity()  { echo ""; }
cat > "$FA_TMP/file-access.json" <<'JSON'
{"protected_ok": false, "probed": [{"path": "/Users/x/Documents", "ok": true}, {"path": "/Users/x/Desktop", "ok": false}], "checked_at": "2026-05-22T00:00:00Z"}
JSON
JSON=$(cmd_status json)
echo "$JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); fa=d["file_access"]; assert fa["protected_ok"] is False, fa; assert any(p["path"]=="/Users/x/Desktop" and p["ok"] is False for p in fa["probed"]), fa' \
  && ok "cmd_status json: file_access present + per-folder probed array" \
  || ng "cmd_status json: file_access missing or malformed"
rm -f "$FA_TMP/file-access.json"
JSON=$(cmd_status json)
echo "$JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["file_access"] is None, d["file_access"]' \
  && ok "cmd_status json: file_access null when probe file absent" \
  || ng "cmd_status json: file_access should be null when absent"
rm -rf "$FA_TMP"

# ─── sleep-fix: pmset parsing + config ───────────────────────────────────────
# _sleep_fix_state reads `pmset -g` (via the PMSET_BIN override) ONCE and reports
# applied|unknown|<risky list> — the settings that still permit a nap would
# freeze the long-poll. A stub pmset pins each state without touching the host.
# The fake reads SF_* from its env so we can flip states, and emits REAL
# `pmset -g` shapes (the "Sleep On Power Button" multi-word key, the active-source
# annotation, minutes-valued keys) so a future parser refactor can't silently
# regress against production output.
SF_TMP=$(mktemp -d)
cat > "$SF_TMP/fake-pmset" <<'EOF'
#!/bin/bash
[[ "${1:-}" == "-g" ]] || exit 0
cat <<OUT
System-wide power settings:
Currently in use:
 Sleep On Power Button 1
 standby              ${SF_STANDBY:-1}
 powernap             ${SF_POWERNAP:-1}
 disksleep            10
 sleep                ${SF_SLEEP:-1}${SF_SLEEP_ANNOT:-}
OUT
EOF
chmod +x "$SF_TMP/fake-pmset"
export PMSET_BIN="$SF_TMP/fake-pmset"

# Hardened host: every nap setting 0 → applied, status exits 0.
export SF_STANDBY=0 SF_POWERNAP=0 SF_SLEEP=0
[[ "$(_sleep_fix_state)" == "applied" ]] \
  && ok "_sleep_fix_state: all-zero pmset → applied" \
  || ng "_sleep_fix_state: all-zero should be 'applied' (got '$(_sleep_fix_state)')"
_config_sleep_fix status >/dev/null 2>&1 \
  && ok "_config_sleep_fix status: hardened → exit 0" \
  || ng "_config_sleep_fix status: hardened should exit 0"

# standby + powernap still on → both reported in pmset order; the multi-word
# "Sleep On Power Button 1" line must NOT be mistaken for the sleep key.
export SF_STANDBY=1 SF_POWERNAP=1 SF_SLEEP=0
[[ "$(_sleep_fix_state)" == "standby powernap" ]] \
  && ok "_sleep_fix_state: standby+powernap on → 'standby powernap'" \
  || ng "_sleep_fix_state: expected 'standby powernap', got '$(_sleep_fix_state)'"
! _config_sleep_fix status >/dev/null 2>&1 \
  && ok "_config_sleep_fix status: risky → exit 1" \
  || ng "_config_sleep_fix status: risky should exit non-zero"

# Real-world annotated value line: `sleep 1 (sleep prevented by caffeinate, ...)`
# — the parser must take the value (1), not choke on the annotation.
export SF_STANDBY=0 SF_POWERNAP=0 SF_SLEEP=1 SF_SLEEP_ANNOT=" (sleep prevented by caffeinate, powerd)"
[[ "$(_sleep_fix_state)" == "sleep" ]] \
  && ok "_sleep_fix_state: annotated 'sleep 1 (...)' → 'sleep'" \
  || ng "_sleep_fix_state: annotated sleep line mis-parsed (got '$(_sleep_fix_state)')"
unset SF_SLEEP_ANNOT

# Minutes-valued sleep (e.g. `sleep 10`) still permits a nap → risky.
export SF_STANDBY=0 SF_POWERNAP=0 SF_SLEEP=10
[[ "$(_sleep_fix_state)" == "sleep" ]] \
  && ok "_sleep_fix_state: 'sleep 10' (minutes) → 'sleep'" \
  || ng "_sleep_fix_state: 'sleep 10' should be risky (got '$(_sleep_fix_state)')"

# pmset absent (e.g. a Linux host) → unknown (NOT a false 'applied'); the install
# recommendation is suppressed (status exits 0) but status is honest.
export PMSET_BIN="$SF_TMP/nope"
[[ "$(_sleep_fix_state)" == "unknown" ]] \
  && ok "_sleep_fix_state: pmset absent → unknown (Linux-safe, honest)" \
  || ng "_sleep_fix_state: absent pmset should be 'unknown' (got '$(_sleep_fix_state)')"
_config_sleep_fix status >/dev/null 2>&1 \
  && ok "_config_sleep_fix status: unknown → exit 0 (suppresses install nag)" \
  || ng "_config_sleep_fix status: unknown should exit 0"
export PMSET_BIN="$SF_TMP/fake-pmset"

# `on` must shell out to: sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0.
# In production the sudo'd binary is HARDCODED; only under CTA_TEST_MODE do we
# honor the PMSET_SUDO/PMSET_BIN stubs so we can record argv without root.
cat > "$SF_TMP/fake-sudo" <<EOF
#!/bin/bash
echo "\$@" > "$SF_TMP/sudo-args"
EOF
chmod +x "$SF_TMP/fake-sudo"
CTA_TEST_MODE=1 PMSET_SUDO="$SF_TMP/fake-sudo" PMSET_BIN="$SF_TMP/fake-pmset" \
  _config_sleep_fix on >/dev/null 2>&1
SF_ARGS=$(cat "$SF_TMP/sudo-args" 2>/dev/null || true)
[[ "$SF_ARGS" == *"sleep 0"* && "$SF_ARGS" == *"standby 0"* && "$SF_ARGS" == *"powernap 0"* ]] \
  && ok "_config_sleep_fix on: sudo pmset disables sleep+standby+powernap" \
  || ng "_config_sleep_fix on: wrong pmset args ('$SF_ARGS')"

# Security: outside CTA_TEST_MODE the sudo'd binary must be hardcoded, NOT chosen
# by an env var (else `PMSET_BIN=/tmp/evil cta config sleep-fix on` = root exec).
grep -q 'CTA_TEST_MODE' "$SCRIPT_DIR/cli/cta" \
  && ok "_config_sleep_fix: sudo binary gated behind CTA_TEST_MODE (no env-chosen root exec)" \
  || ng "_config_sleep_fix: missing CTA_TEST_MODE guard on the privileged binary"

# Bad arg → usage error, non-zero.
_config_sleep_fix banana >/dev/null 2>&1 \
  && ng "_config_sleep_fix banana: should exit non-zero" \
  || ok "_config_sleep_fix banana: rejected"

unset PMSET_BIN SF_STANDBY SF_POWERNAP SF_SLEEP
rm -rf "$SF_TMP"

# ─── pipefail+SIGPIPE regression guard ───────────────────────────────────────
# Under `set -uo pipefail`, the old `launchctl list | grep -q LABEL` (and
# similar ps|grep|head pipelines for _claude_ps_line / _mcp_alive) flipped
# false intermittently under I/O load: the downstream sink closes its stdin
# on first match, the upstream gets SIGPIPE, pipefail propagates non-zero,
# and Pager shows a spurious "Degraded — LaunchAgent not loaded".
#
# These tests assert the function bodies use the atomic forms (no
# `| grep -q`, no bare `| head -1` chain) so an accidental revert blows up
# CI instead of silently re-introducing the flicker. Empirical load-time
# verification (200/200 green) lives in the bug-investigation memory.

# Earlier sections override these functions with stubs, so re-source cta in a
# clean subshell and capture the real function bodies before assertions.
bodies=$(bash -c '
set -uo pipefail
source "'"$SCRIPT_DIR"'/cli/cta"
echo "===_la_loaded==="
declare -f _la_loaded
echo "===_mcp_alive==="
declare -f _mcp_alive
echo "===_claude_ps_line==="
declare -f _claude_ps_line
')

la_body="$(awk '/^===_la_loaded===/,/^===_mcp_alive===/' <<< "$bodies")"
mcp_body="$(awk '/^===_mcp_alive===/,/^===_claude_ps_line===/' <<< "$bodies")"
ps_body="$(awk '/^===_claude_ps_line===/,0' <<< "$bodies")"

if [[ "$la_body" != *"| grep -q"* ]]; then
  ok "_la_loaded: no pipefail-vulnerable grep -q pipe"
else
  ng "_la_loaded: still contains '| grep -q' (pipefail+SIGPIPE risk)"
fi
if [[ "$la_body" == *"launchctl list \"\$PLIST_LABEL\""* || "$la_body" == *"launchctl list \$PLIST_LABEL"* ]]; then
  ok "_la_loaded: uses atomic launchctl list LABEL form"
else
  ng "_la_loaded: does not use atomic launchctl list LABEL form"
fi

if [[ "$mcp_body" == *"pgrep"* && "$mcp_body" != *"| grep -v grep"* ]]; then
  ok "_mcp_alive: atomic pgrep -f form, no ps|grep|head chain"
else
  ng "_mcp_alive: not using atomic pgrep -f form"
fi

if [[ "$ps_body" == *"set +o pipefail"* ]]; then
  ok "_claude_ps_line: pipefail disabled in subshell around head -1 chain"
else
  ng "_claude_ps_line: missing 'set +o pipefail' guard around head -1 chain"
fi

# ─── _topic_name: forum topic name lookup ─────────────────────────────────────
# Topic names are cached by the poller in $STATE_DIR/topics.json from
# forum_topic_created / forum_topic_edited service messages. cta list joins
# this cache with the mount list so the user sees "Iron Flow" instead of
# bare thread_id 140. Test the helper in isolation against a fixture state dir.

topic_test_dir=$(mktemp -d)
mkdir -p "$topic_test_dir"
cat > "$topic_test_dir/paired.json" <<EOF
{"version":1,"chat_id":-1003738946626,"user_id":1,"paired_at":"2026-05-16T00:00:00Z"}
EOF
cat > "$topic_test_dir/topics.json" <<EOF
{"version":1,"topics":{"-1003738946626/140":{"name":"Iron Flow","captured_at":"2026-05-16T00:00:00Z"}}}
EOF

run_topic_name() {
  CTA_STATE_DIR="$topic_test_dir" bash -c '
    set -uo pipefail
    source "'"$SCRIPT_DIR"'/cli/cta"
    _topic_name "'"$1"'"
  '
}

[[ "$(run_topic_name 140)" == "Iron Flow" ]] \
  && ok "_topic_name: numeric thread_id with cached topic returns name" \
  || ng "_topic_name: 140 → expected 'Iron Flow', got '$(run_topic_name 140)'"

[[ -z "$(run_topic_name 999)" ]] \
  && ok "_topic_name: unknown numeric thread_id returns empty" \
  || ng "_topic_name: 999 (uncached) should return empty"

# dm in a group chat → "General" (the General topic catches no-thread_id
# messages; the fixture's chat_id is negative = group). For DMs the fixture
# would use a positive chat_id and dm would return empty — covered separately
# below.
[[ "$(run_topic_name dm)" == "General" ]] \
  && ok "_topic_name: 'dm' in group returns 'General'" \
  || ng "_topic_name: 'dm' in group should return 'General', got '$(run_topic_name dm)'"

[[ -z "$(run_topic_name '*')" ]] \
  && ok "_topic_name: wildcard '*' returns empty" \
  || ng "_topic_name: '*' should return empty"

# dm in a private chat (positive chat_id) → empty, since there's no General
# topic to label and the dm sentinel is just the chat root.
cat > "$topic_test_dir/paired.json" <<EOF
{"version":1,"chat_id":12345,"user_id":1,"paired_at":"2026-05-16T00:00:00Z"}
EOF
[[ -z "$(run_topic_name dm)" ]] \
  && ok "_topic_name: 'dm' in private chat returns empty" \
  || ng "_topic_name: 'dm' in private chat should return empty, got '$(run_topic_name dm)'"
# Restore group fixture for downstream tests
cat > "$topic_test_dir/paired.json" <<EOF
{"version":1,"chat_id":-1003738946626,"user_id":1,"paired_at":"2026-05-16T00:00:00Z"}
EOF

# Missing topics.json → graceful empty
rm -f "$topic_test_dir/topics.json"
[[ -z "$(run_topic_name 140)" ]] \
  && ok "_topic_name: missing topics.json returns empty without error" \
  || ng "_topic_name: missing topics.json should return empty"

# Missing paired.json → graceful empty (no chat_id, so no lookup key)
cat > "$topic_test_dir/topics.json" <<EOF
{"version":1,"topics":{"-1003738946626/140":{"name":"Iron Flow","captured_at":"2026-05-16T00:00:00Z"}}}
EOF
rm -f "$topic_test_dir/paired.json"
[[ -z "$(run_topic_name 140)" ]] \
  && ok "_topic_name: missing paired.json returns empty without error" \
  || ng "_topic_name: missing paired.json should return empty"

rm -rf "$topic_test_dir"

# ─── state path derivation regression guard ──────────────────────────────────
# Bug: cta hardcoded $HOME/.claude-telegram-agent/pairing-code for the pairing
# code file, while the poller (agent/lib/paths.ts) reads from
# stateDir()/pairing-code (default $HOME/.pager). Result: `cta pair-code`
# showed code A, poller checked against code B, every /pair attempt failed
# with "Pairing code did not match."
#
# Same shape failed for paired.json and mounts.json. Root cause: a legacy
# hardcode kept after state-dir migration. Class of bug, not one-off.
#
# Defense:
#   1. Top-of-file STATE_DIR block defines all state-file paths from $STATE_DIR.
#   2. This test asserts (a) the values resolve through $STATE_DIR / $INSTALL_DIR
#      and (b) no NEW legacy hardcodes have been added outside cmd_migrate_state.

state_paths_resolve_from_state_dir() {
  bash -c '
    set -uo pipefail
    source "'"$SCRIPT_DIR"'/cli/cta"
    # Each state-file path must contain $STATE_DIR (default ~/.pager) or
    # $INSTALL_DIR (default ~/.local/share/pager) when expanded.
    for var in PAIRING_CODE_FILE PAIRED_STATE_FILE MOUNTS_FILE TASKS_FILE TASK_RUN_DIR ENV_FILE CAFFEINATE_PID_FILE; do
      val="${!var}"
      case "$val" in
        "$STATE_DIR"/*) ;;
        *) echo "FAIL: $var=$val does not start with \$STATE_DIR=$STATE_DIR"; exit 1 ;;
      esac
    done
    case "$MOUNT_STORE_TS" in
      "$INSTALL_DIR"/*) ;;
      *) echo "FAIL: MOUNT_STORE_TS=$MOUNT_STORE_TS does not start with \$INSTALL_DIR=$INSTALL_DIR"; exit 1 ;;
    esac
  '
}
if state_paths_resolve_from_state_dir; then
  ok "state paths: all resolve from \$STATE_DIR / \$INSTALL_DIR"
else
  ng "state paths: at least one hardcodes a legacy location"
fi

# Override CTA_STATE_DIR to make sure the path indirection is real (not just
# a literal "$HOME/.pager" coincidence). If any path is hardcoded, this fails.
overridden_state_dir_takes_effect() {
  CTA_STATE_DIR=/tmp/cta-test-state-$$ bash -c '
    set -uo pipefail
    source "'"$SCRIPT_DIR"'/cli/cta"
    for var in PAIRING_CODE_FILE PAIRED_STATE_FILE MOUNTS_FILE TASKS_FILE TASK_RUN_DIR ENV_FILE CAFFEINATE_PID_FILE; do
      val="${!var}"
      case "$val" in
        /tmp/cta-test-state-*/*) ;;
        *) echo "FAIL: $var=$val ignored CTA_STATE_DIR override"; exit 1 ;;
      esac
    done
  '
}
if overridden_state_dir_takes_effect; then
  ok "state paths: respect CTA_STATE_DIR env override"
else
  ng "state paths: at least one ignores CTA_STATE_DIR (hardcoded path)"
fi

# Structural guard: grep for legacy hardcodes outside the allowlist.
# Allowed legacy refs are: LEGACY_STATE_DIR / LEGACY_INSTALL_DIR definitions
# (intentional, for migrate-state), the warning comment, and the body of
# cmd_migrate_state. Anything else is a regression.
legacy_hardcode_count() {
  # Strip cmd_migrate_state body (function-scope only)
  awk '
    /^cmd_migrate_state\(\) \{/ { in_fn=1 }
    in_fn && /^\}/ { in_fn=0; next }
    !in_fn
  ' "$SCRIPT_DIR/cli/cta" | grep -cE '\$HOME/\.(claude-telegram-agent|local/share/claude-telegram-agent)'
}
hc=$(legacy_hardcode_count)
# Expected refs OUTSIDE cmd_migrate_state:
#   - LEGACY_STATE_DIR=...        (line 49)
#   - LEGACY_INSTALL_DIR=...      (line 50)
#   - the comment that explains the bug (1 line)
if [[ "$hc" -le 3 ]]; then
  ok "legacy hardcodes outside cmd_migrate_state: $hc (allowlisted: LEGACY_*_DIR + warning comment)"
else
  ng "legacy hardcodes outside cmd_migrate_state: $hc (expected ≤3 — new hardcode? use \$STATE_DIR / \$INSTALL_DIR)"
fi

# ─── Phase 4 status semantics regression guard ───────────────────────────────
# In Phase 4 daemon mode the long-lived "always-on" process is the POLLER
# (bun), not a persistent `claude --channels` process. Status helpers must
# resolve their liveness against the poller pattern, not v0's claude grep.
#
# Source of truth: scripts/check-no-secrets.sh' style — grep the script
# itself so a refactor that drops the poller pattern breaks this test.
# Stronger than a behavioral test because there's no good way to mock
# `ps` and `pgrep` cross-platform without spawning real processes.
if grep -q 'bun .\*/agent/poller/poller\\.ts\$' "$SCRIPT_DIR/cli/cta"; then
  ok "Phase 4: _claude_ps_line + _mcp_alive use the anchored poller pattern"
else
  ng "Phase 4: poller pattern missing — Pager status flips red between turns"
fi

# Both helpers must use the SAME anchored pattern. Diverging here would
# create a "claude.pid found but telegram_mcp false" state that confuses
# the Pager status pill.
if [[ $(grep -c 'bun .\*/agent/poller/poller\\.ts\$' "$SCRIPT_DIR/cli/cta") -ge 2 ]]; then
  ok "Phase 4: claude.pid + telegram_mcp use the same poller-anchored pattern"
else
  ng "Phase 4: claude.pid + telegram_mcp diverged — Pager status will flap"
fi

# heartbeat-poller must be the last_activity source. v0 bot.pid alone
# doesn't get touched in Phase 4 (the official plugin's heartbeat — daemon
# mode never starts it), so last_activity would be null forever.
if grep -q 'heartbeat-poller' "$SCRIPT_DIR/cli/cta"; then
  ok "Phase 4: _last_activity reads from heartbeat-poller"
else
  ng "Phase 4: _last_activity still uses only bot.pid → null in daemon mode"
fi

# ─── H2 daily digest config knobs ─────────────────────────────────────────────
# _config_digest_time, _config_quiet_hours, _config_timezone all write to
# settings.json under their respective keys. Validate input, round-trip.

DIGEST_TMP=$(mktemp -d)
SETTINGS_FILE="$DIGEST_TMP/settings.json"
STATE_DIR="$DIGEST_TMP"

# digest-time happy path
_config_digest_time "09:30" >/dev/null
DT_READ=$(_config_digest_time)
[[ "$DT_READ" == "09:30" ]] && ok "_config_digest_time: round-trips HH:MM" \
                            || ng "_config_digest_time: expected 09:30 got '$DT_READ'"

# digest-time validates HH:MM (reject garbage)
if _config_digest_time "garbage" 2>/dev/null; then
  ng "_config_digest_time: should reject 'garbage'"
else
  ok "_config_digest_time: rejects non-HH:MM input"
fi

# digest-time clear via 'off'
_config_digest_time "off" >/dev/null
DT_CLEARED=$(_config_digest_time)
[[ "$DT_CLEARED" == "09:00" ]] && ok "_config_digest_time: 'off' clears to default 09:00" \
                               || ng "_config_digest_time: 'off' clear failed (got '$DT_CLEARED')"

# quiet-hours non-wrap
_config_quiet_hours "13:00" "17:00" >/dev/null
QH_READ=$(_config_quiet_hours)
echo "$QH_READ" | grep -q '"start": *"13:00"' && echo "$QH_READ" | grep -q '"end": *"17:00"' \
  && ok "_config_quiet_hours: round-trips non-wrapping window" \
  || ng "_config_quiet_hours: round-trip failed (got '$QH_READ')"

# quiet-hours wrap-midnight (gives wrap notice in output)
QH_OUT=$(_config_quiet_hours "23:00" "07:00" 2>&1)
echo "$QH_OUT" | grep -q "wraps midnight" \
  && ok "_config_quiet_hours: notes wrap-midnight in confirmation" \
  || ng "_config_quiet_hours: wrap-midnight notice missing (got '$QH_OUT')"

# quiet-hours validates each half independently
if _config_quiet_hours "garbage" "07:00" 2>/dev/null; then
  ng "_config_quiet_hours: should reject bad 'start'"
else
  ok "_config_quiet_hours: rejects malformed start HH:MM"
fi

# quiet-hours clear via 'off'
_config_quiet_hours "off" "" >/dev/null
QH_CLEARED=$(_config_quiet_hours)
[[ "$QH_CLEARED" == "(none)" ]] && ok "_config_quiet_hours: 'off' clears" \
                                || ng "_config_quiet_hours: 'off' clear failed (got '$QH_CLEARED')"

# timezone IANA round-trip
_config_timezone "Asia/Tokyo" >/dev/null
TZ_READ=$(_config_timezone)
[[ "$TZ_READ" == "Asia/Tokyo" ]] && ok "_config_timezone: round-trips IANA tz" \
                                 || ng "_config_timezone: round-trip failed (got '$TZ_READ')"

# timezone rejects obviously bad input (shell-metachar-bearing strings)
if _config_timezone "Asia/Tokyo;rm" 2>/dev/null; then
  ng "_config_timezone: should reject input with shell metachars"
else
  ok "_config_timezone: rejects shell-metachar input"
fi

# timezone clear via 'off'
_config_timezone "off" >/dev/null
TZ_CLEARED=$(_config_timezone)
[[ "$TZ_CLEARED" == "(system default)" ]] && ok "_config_timezone: 'off' clears" \
                                          || ng "_config_timezone: 'off' clear failed (got '$TZ_CLEARED')"

# Settings file shape: all keys present at once should round-trip without
# clobbering each other. Pin the JSON-merge contract.
_config_digest_time "10:00" >/dev/null
_config_quiet_hours "22:00" "06:00" >/dev/null
_config_timezone "America/Los_Angeles" >/dev/null
python3 - "$SETTINGS_FILE" <<'PY' && ok "settings.json: digest fields coexist without clobber" \
                                   || ng "settings.json: field clobber"
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
assert d.get("digestTime") == "10:00"
assert d.get("quietHours") == {"start":"22:00", "end":"06:00"}
assert d.get("timezone") == "America/Los_Angeles"
assert d.get("version") == 1
PY

rm -rf "$DIGEST_TMP"

# ─── summary ─────────────────────────────────────────────────────────────────

echo
echo "cta: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
