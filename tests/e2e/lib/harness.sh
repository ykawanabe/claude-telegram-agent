#!/bin/bash
# tests/e2e/lib/harness.sh — scenario primitives for the agent-runnable E2E
# harness. Sourced by each tests/e2e/scenarios/<name>.sh.
#
# Conventions:
#   - `h_` prefix on all exported functions (harness namespace).
#   - Each scenario gets a fresh sandbox in $SCENARIO_DIR (tmp).
#   - tmux runs on a private socket (-L) so the user's real server is untouched.
#   - All mutating ops are idempotent; teardown runs from EXIT trap.
#
# Required env on enter: none. Required tools: bash, bun, tmux, curl, jq.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export REPO_DIR

# Per-scenario state. Populated by h_setup_sandbox.
SCENARIO_DIR=""
MOCK_PORT=0
MOCK_PID=""
MOCK_RECORD=""
MOCK_LOG=""
TMUX_SOCKET=""
POLLER_PID=""
ORIGINAL_PATH="$PATH"

# Track test results.
H_PASS=0
H_FAIL=0
h_ok() { echo "  ok  $1";   H_PASS=$((H_PASS + 1)); }
h_ng() { echo "  FAIL $1"; H_FAIL=$((H_FAIL + 1)); }

# Find a free port (best-effort; bun.serve will fail loudly if taken).
h_pick_port() {
  local p
  for _ in $(seq 1 20); do
    p=$(( ( RANDOM % 20000 ) + 30000 ))
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$p"
      return
    fi
  done
  echo "$p"  # last-tried, even if taken
}

h_setup_sandbox() {
  local name="${1:-scenario}"
  # Use /tmp directly (not the default tmpdir under /var/folders/...) so
  # tmux's socket path stays under macOS's ~104-char limit. tmux server
  # crashes with "File name too long" otherwise.
  SCENARIO_DIR=$(mktemp -d "/tmp/e2e-${name}.XXXXXX")
  export CTA_STATE_DIR="$SCENARIO_DIR/state"
  export CTA_INSTALL_DIR="$SCENARIO_DIR/install"
  mkdir -p "$CTA_STATE_DIR" "$CTA_INSTALL_DIR/agent"

  # Mirror agent sources into the install dir so the poller and friends
  # resolve their helpers under the standard $CTA_INSTALL_DIR layout.
  #
  # Copy whole source dirs, NOT a hand-picked file list. poller.ts's import
  # graph stays entirely within these dirs (verified: only ./, ../channels,
  # ../delivery, ../observability, ../mount-store, ../tasks-store, ../lib imports). A cherry-picked cp list
  # silently broke ALL e2e twice — when P4 added buttons-marker.ts, then
  # again when the FDA work added file-access-probe.ts — because CI never
  # runs e2e to catch the drift. Directory copies are self-maintaining: a
  # new sibling import can't desync the sandbox. Dirs hold no node_modules
  # and total <400K, so the copy stays cheap.
  cp -R "$REPO_DIR/agent/poller" "$CTA_INSTALL_DIR/agent/"
  cp -R "$REPO_DIR/agent/mount-store" "$CTA_INSTALL_DIR/agent/"
  cp -R "$REPO_DIR/agent/tasks-store" "$CTA_INSTALL_DIR/agent/"
  cp -R "$REPO_DIR/agent/lib" "$CTA_INSTALL_DIR/agent/"
  cp -R "$REPO_DIR/agent/channels" "$CTA_INSTALL_DIR/agent/"
  cp -R "$REPO_DIR/agent/delivery" "$CTA_INSTALL_DIR/agent/"
  cp -R "$REPO_DIR/agent/observability" "$CTA_INSTALL_DIR/agent/"

  # Plugin .env (the canonical TELEGRAM_BOT_TOKEN source).
  mkdir -p "$SCENARIO_DIR/plugin"
  cat > "$SCENARIO_DIR/plugin/.env" <<'EOF'
TELEGRAM_BOT_TOKEN=FAKE-E2E-TOKEN
EOF
  # Project .env. POLL_TIMEOUT_SEC tuned low so scenarios complete fast.
  cat > "$CTA_STATE_DIR/.env" <<'EOF'
MULTI_TOPIC=1
POLL_TIMEOUT_SEC=1
EOF
  # Private tmux socket per scenario keeps us isolated from the user's
  # real tmux server. Short name + scenario tmpdir to stay under macOS's
  # 104-char sun_path limit even when scenario dirs nest under /tmp.
  TMUX_SOCKET="$SCENARIO_DIR/s"

  # Strip TMUX env that would tie children back to the outer tmux server.
  unset TMUX TMUX_PANE
}

h_spawn_mock() {
  MOCK_PORT=$(h_pick_port)
  MOCK_RECORD="$SCENARIO_DIR/mock-record.jsonl"
  MOCK_LOG="$SCENARIO_DIR/mock.log"
  bun run "$REPO_DIR/tests/mock-bot-api.ts" "$MOCK_PORT" "$MOCK_RECORD" \
    > "$MOCK_LOG" 2>&1 &
  MOCK_PID=$!
  # Poll until live.
  for _ in $(seq 1 50); do
    if curl -fsS "http://localhost:${MOCK_PORT}/botFAKE/getMe" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if ! curl -fsS "http://localhost:${MOCK_PORT}/botFAKE/getMe" >/dev/null 2>&1; then
    echo "mock-bot-api failed to start on :$MOCK_PORT — log:" >&2
    cat "$MOCK_LOG" >&2
    return 1
  fi
  export TELEGRAM_API_BASE="http://localhost:${MOCK_PORT}/botFAKE-E2E-TOKEN"
  export TELEGRAM_BOT_TOKEN="FAKE-E2E-TOKEN"
}

# Seed paired.json directly to skip the pairing flow. Most scenarios
# assume an already-paired bot.
h_seed_paired() {
  local chat_id="${1:--1001234}"
  local user_id="${2:-99}"
  cat > "$CTA_STATE_DIR/paired.json" <<EOF
{"version":1,"chat_id":${chat_id},"user_id":${user_id},"paired_at":"2026-05-18T00:00:00Z"}
EOF
}

# Seed a mount directly via mount-store CLI. Useful for scenarios that
# want to start at "topic 42 is already mounted at X."
h_seed_mount() {
  local thread_id="$1" path="$2" label="${3:-test}"
  bun run "$CTA_INSTALL_DIR/agent/mount-store/mount-store.ts" add "$thread_id" "$path" "$label" >/dev/null
}

# Seed a per-thread session UUID file (what the poller reads for
# --resume vs --session-id).
h_seed_session_uuid() {
  local thread_id="$1" uuid="$2"
  mkdir -p "$CTA_STATE_DIR/sessions"
  echo "$uuid" > "$CTA_STATE_DIR/sessions/$thread_id"
}

# Spawn the poller pointed at the mock. Runs in a tmux session named
# "poller" on the private socket so we don't conflict with the user's
# real poller.
h_spawn_poller() {
  local poller_path="$CTA_INSTALL_DIR/agent/poller/poller.ts"
  local env_file="$CTA_STATE_DIR/.env"
  local plugin_env="$SCENARIO_DIR/plugin/.env"

  # The poller respects TELEGRAM_API_BASE: we keep the api-base exactly
  # matching the getApiBase() return shape (no /bot<TOKEN> suffix — the
  # adapter appends that).
  tmux -S "$TMUX_SOCKET" new-session -d -s poller \
    "bash -c '
      set -a
      [ -f \"$env_file\" ] && . \"$env_file\"
      [ -f \"$plugin_env\" ] && . \"$plugin_env\"
      set +a
      export TELEGRAM_API_BASE=\"http://localhost:${MOCK_PORT}/bot\$TELEGRAM_BOT_TOKEN\"
      cd \"$CTA_INSTALL_DIR/agent/poller\"
      exec bun \"$poller_path\"
    '"

  # Wait for the poller to do its first getUpdates call (visible as a
  # capture entry). Otherwise the first inject might land in an empty
  # queue while the poller's still booting.
  h_wait_for_capture getUpdates 'length >= 1' 10 || {
    echo "poller didn't make first getUpdates within 10s — log:" >&2
    tmux -S "$TMUX_SOCKET" capture-pane -t poller -p -S - 2>/dev/null | tail -30 >&2
    return 1
  }
}

# POST a TG Update to the mock. Convenience wrapper for the common
# text-message-in-topic shape.
h_inject_text() {
  local thread_id="$1" text="$2" from_id="${3:-99}" chat_id="${4:--1001234}"
  local payload
  if [[ -n "$thread_id" && "$thread_id" != "dm" ]]; then
    payload=$(jq -nc --arg t "$text" --argjson tid "$thread_id" --argjson uid "$from_id" --argjson cid "$chat_id" '
      {
        message: {
          message_id: 1,
          from: {id: $uid, is_bot: false, first_name: "Tester"},
          chat: {id: $cid, type: "supergroup"},
          message_thread_id: $tid,
          date: now | floor,
          text: $t
        }
      }')
  else
    payload=$(jq -nc --arg t "$text" --argjson uid "$from_id" --argjson cid "$chat_id" '
      {
        message: {
          message_id: 1,
          from: {id: $uid, is_bot: false, first_name: "Tester"},
          chat: {id: $cid, type: "supergroup"},
          date: now | floor,
          text: $t
        }
      }')
  fi
  curl -fsS -X POST -H 'content-type: application/json' \
    -d "$payload" "http://localhost:${MOCK_PORT}/__test__/inject" >/dev/null
}

# Wait until the captured store matches a jq predicate over the items
# array, or timeout. Returns 0 on match, 1 on timeout.
#   $1: method to filter on (e.g., "sendMessage"), or "" for all.
#   $2: jq predicate over [Item]. Example: '[.[] | select(.body.text|test("Cleared"))] | length >= 1'
#   $3: timeout seconds (default 15).
h_wait_for_capture() {
  local wanted="${1:-}" predicate="$2" timeout="${3:-15}"
  local url="http://localhost:${MOCK_PORT}/__test__/captured"
  [[ -n "$wanted" ]] && url="${url}?method=${wanted}"
  local deadline=$(( $(date +%s) + timeout ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    local items
    items=$(curl -fsS "$url" | jq -r ".items | $predicate" 2>/dev/null)
    if [[ "$items" == "true" || "$items" =~ ^[0-9]+$ && "$items" -gt 0 ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# Dump all captures for diagnostic on failure.
h_dump_captures() {
  echo "  --- captures (recordFile) ---"
  if [[ -f "$MOCK_RECORD" ]]; then
    cat "$MOCK_RECORD" | sed 's/^/  | /' | head -60
  else
    echo "  (record file missing: $MOCK_RECORD)"
  fi
  echo "  --- poller pane ---"
  tmux -S "$TMUX_SOCKET" capture-pane -t poller -p -S - 2>/dev/null | tail -30 | sed 's/^/  | /' || true
  echo "  --- mount state ---"
  cat "$CTA_STATE_DIR/mounts.json" 2>/dev/null | sed 's/^/  | /' || echo "  (no mounts.json)"
  echo "  --- sessions ---"
  ls -la "$CTA_STATE_DIR/sessions" 2>/dev/null | sed 's/^/  | /' || echo "  (no sessions dir)"
}

# Assert a state file matches a jq predicate. Usage:
#   h_assert_jq <file> <predicate> "<description>"
h_assert_jq() {
  local file="$1" predicate="$2" desc="$3"
  if [[ ! -f "$file" ]]; then
    h_ng "$desc — file missing: $file"
    return 1
  fi
  if jq -e "$predicate" "$file" >/dev/null 2>&1; then
    h_ok "$desc"
  else
    h_ng "$desc — predicate failed against $file"
    cat "$file" | head -20 | sed 's/^/    | /'
    return 1
  fi
}

# Assert a non-JSON file has content matching a regex.
h_assert_file_grep() {
  local file="$1" pattern="$2" desc="$3"
  if [[ ! -f "$file" ]]; then
    h_ng "$desc — file missing: $file"
    return 1
  fi
  if grep -qE "$pattern" "$file"; then
    h_ok "$desc"
  else
    h_ng "$desc — pattern '$pattern' not found in $file"
    return 1
  fi
}

h_teardown() {
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  if [[ -n "$TMUX_SOCKET" ]]; then
    tmux -S "$TMUX_SOCKET" kill-server 2>/dev/null || true
  fi
  if [[ -n "$SCENARIO_DIR" && -d "$SCENARIO_DIR" ]]; then
    rm -rf "$SCENARIO_DIR"
  fi
}

# Auto-teardown on EXIT. Scenarios can override by trapping again.
trap 'h_teardown' EXIT INT TERM
