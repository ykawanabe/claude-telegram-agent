/**
 * Heartbeat runner — H2 daily digest (Design A).
 *
 * Owns the per-fire flow for one mount:
 *   1. Read mount.path/HEARTBEAT.md → check IDs + free-form context.
 *   2. Dispatch every check in parallel (TypeScript handlers via the registry).
 *   3. Spawn `claude -p` with `--tools "Read,Glob,Grep"` (NO Bash) and feed the
 *      pre-computed results as the user prompt. The model's only job: turn
 *      the results JSON into a 3-7 line digest or return NOTHING_TO_REPORT.
 *   4. Parse stream-json output for the assistant text and cost (`result`
 *      event's `total_cost_usd`).
 *   5. Apply the NOTHING_TO_REPORT gate. Return a DigestResult.
 *
 * Safety invariant (Design A): claude is spawned with `--tools "Read,Glob,Grep"`.
 * Bash is absent from the tool list. The model literally cannot call shell,
 * cannot reach `gh`/`git`, cannot escape via metacharacter — there's no Bash
 * tool to escape.
 *
 * This module does NOT decide WHEN to fire (the scheduler in poller.ts does),
 * does NOT persist run state (the scheduler does), does NOT send to Telegram
 * (the scheduler does after calling us). It's a pure "given a mount, produce
 * one digest result" function.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHeartbeatMd } from "./heartbeat-md";
import { runCheck, type CheckResult, type HandlerContext } from "./registry";
import { createTranscriptCursor } from "../transcript-cursor";

// Public types ───────────────────────────────────────────────────────────────

export interface RunHeartbeatOpts {
  /** mount.path — read HEARTBEAT.md here, also becomes claude's cwd. */
  readonly mountPath: string;
  /** thread_id from mount, for logging only. */
  readonly threadId: string;
  /** UUID for `claude --resume` so day N+1 sees day N's findings. Caller
   *  manages lifecycle (create on first run, persist across fires). */
  readonly sessionUuid: string;
  /** True when the sessionUuid refers to an existing claude session (build
   *  argv with `--resume`). False on the first fire when the UUID was just
   *  generated (build argv with `--session-id` so claude CREATES the
   *  session). Mirrors claude-daemon.ts:buildArgv's `resumeExisting` flag.
   *  Default true (assume existing) so callers that don't know just retry
   *  on the error path. */
  readonly resumeExisting?: boolean;

  // Optional / overridable
  readonly claudeBin?: string;             // default "claude"
  readonly model?: string;                 // default "claude-sonnet-4-6"
  /** Per-check timeout ms (passed to handlers). Default 10s. */
  readonly checkTimeoutMs?: number;
  /** Runner overall budget. SIGTERM at sigTermMs, SIGKILL at sigKillMs.
   *  Defaults: 75s / 90s. */
  readonly sigTermMs?: number;
  readonly sigKillMs?: number;

  // Test seams (all default to production behavior)
  readonly readHeartbeatMd?: (path: string) => Promise<string | null>;
  readonly dispatchCheck?: (id: string, ctx: HandlerContext) => Promise<CheckResult>;
  readonly spawn?: ClaudeSpawnLike;
}

export type DigestStatus =
  | "sent"          // claude produced a non-empty digest → deliver to chat
  | "empty"         // claude returned NOTHING_TO_REPORT → drop the send
  | "no-heartbeat-md"   // HEARTBEAT.md missing or had no check IDs
  | "error"         // claude exit≠0 or stream parse failed
  | "timeout";      // exceeded sigKillMs

export interface DigestResult {
  readonly status: DigestStatus;
  /** Final assistant text. Always null for non-"sent" statuses. */
  readonly digestText: string | null;
  /** From stream-json `result.total_cost_usd`. 0 if not captured (e.g. timeout). */
  readonly totalCostUsd: number;
  readonly durationMs: number;
  /** Check IDs we attempted (parsed from HEARTBEAT.md). */
  readonly checksRan: readonly string[];
  /** Subset of checksRan whose handler returned status="error" or "timeout". */
  readonly checksErrored: readonly string[];
  /** Human-readable detail when status is error/timeout/no-heartbeat-md. */
  readonly errorMessage?: string;
}

/**
 * Spawn seam — narrowest possible shape of Bun.spawn that the runner uses.
 * Lets tests inject canned output without depending on Bun's Subprocess type
 * (which differs across versions). Same pattern as `SpawnLike` in open-prs.ts.
 */
export interface ClaudeSpawnLike {
  (opts: {
    cmd: string[];
    cwd: string;
    stdout: "pipe";
    stderr: "pipe";
    signal?: AbortSignal;
  }): {
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
    exited: Promise<number>;
    kill?: (sig?: number | NodeJS.Signals) => void;
    killed?: boolean;
  };
}

// Internals ──────────────────────────────────────────────────────────────────

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_SIGTERM_MS = 75_000;
const DEFAULT_SIGKILL_MS = 90_000;

/** Gate: match the entire trimmed assistant turn against the empty-digest phrase.
 *  Allows ` `, trailing `.` / `!`, optional markdown bold/italic wrappers, and
 *  case-insensitive match. Does NOT match substring — `NOTHING_TO_REPORT but
 *  also there's an open PR` would not drop. */
const NOTHING_TO_REPORT_RE = /^\s*\*{0,2}NOTHING_TO_REPORT\*{0,2}[.!]?\s*$/i;

const SYSTEM_PROMPT = [
  "You are the daily heartbeat digest summarizer for a developer's Telegram bot.",
  "Input arrives as a single user message containing JSON: `{ checks: {<id>: {status, items, errorMessage?}}, context: \"...\" }`.",
  "Your only job: produce a 3-7 line plain-text digest of actionable items, or the EXACT phrase `NOTHING_TO_REPORT` if no items warrant the user's attention.",
  "Rules:",
  "  - Plain text. NO markdown (no **bold**, no headers, no bullet syntax other than a leading `-`).",
  "  - Telegram is the rendering surface; assume mobile.",
  "  - If a check has status=\"error\" or \"timeout\", briefly note it inline (don't fabricate items from a failed check).",
  "  - If the only signal is errors, surface those: \"open-prs check failed: gh auth missing\".",
  "  - If no actionable items AND no errors worth surfacing, output exactly `NOTHING_TO_REPORT` (no other text, no period).",
  "Available tools: Read, Glob, Grep — to inspect the worktree for additional context only. Do not call them unless the user's free-form context section references something you need to look at.",
].join("\n");

/** Build the user-turn prompt that frames the results JSON for the model. */
function buildUserPrompt(
  results: Record<string, CheckResult>,
  context: string,
): string {
  const payload = { checks: results, context };
  return [
    "Heartbeat digest input below. Produce the digest per your system instructions.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

/** Build the claude argv. Exported only for tests. */
export function buildClaudeArgv(opts: {
  prompt: string;
  sessionUuid: string;
  model: string;
  /** True → use `--resume <uuid>` (claude requires the session to exist).
   *  False → use `--session-id <uuid>` (claude creates a session with that ID). */
  resumeExisting: boolean;
}): string[] {
  return [
    "-p", opts.prompt,
    opts.resumeExisting ? "--resume" : "--session-id", opts.sessionUuid,
    "--output-format", "stream-json",
    "--verbose",
    "--model", opts.model,
    "--tools", "Read,Glob,Grep",
    "--append-system-prompt", SYSTEM_PROMPT,
    "--dangerously-skip-permissions",
  ];
}

interface StreamParseResult {
  assistantText: string;
  totalCostUsd: number;
}

/** Parse newline-delimited claude stream-json events, accumulating assistant
 *  text blocks and capturing the final result event's cost. Tolerates non-JSON
 *  noise lines (claude occasionally emits them at startup). Same shape as the
 *  daemon's handleEvent loop in claude-daemon.ts. */
export function parseStreamJson(stdout: string): StreamParseResult {
  const cursor = createTranscriptCursor();
  let assistantText = "";
  let totalCostUsd = 0;
  for (const event of [...cursor.push(stdout), ...cursor.finish()]) {
    if (event.type === "assistant") assistantText += event.text;
    else if (event.costUsd !== undefined) totalCostUsd = event.costUsd;
  }
  return { assistantText, totalCostUsd };
}

/** Default HEARTBEAT.md reader. Returns null when the file doesn't exist. */
async function defaultReadHeartbeatMd(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Main entry ─────────────────────────────────────────────────────────────────

export async function runHeartbeat(opts: RunHeartbeatOpts): Promise<DigestResult> {
  const startedAt = Date.now();
  const readMd = opts.readHeartbeatMd ?? defaultReadHeartbeatMd;
  const dispatch = opts.dispatchCheck ?? runCheck;
  const spawn = opts.spawn ?? (Bun.spawn as unknown as ClaudeSpawnLike);
  const claudeBin = opts.claudeBin ?? DEFAULT_CLAUDE_BIN;
  const model = opts.model ?? DEFAULT_MODEL;
  const checkTimeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const sigTermMs = opts.sigTermMs ?? DEFAULT_SIGTERM_MS;
  const sigKillMs = opts.sigKillMs ?? DEFAULT_SIGKILL_MS;

  // Step 1: read HEARTBEAT.md
  const heartbeatPath = join(opts.mountPath, "HEARTBEAT.md");
  const content = await readMd(heartbeatPath);
  if (content === null) {
    return {
      status: "no-heartbeat-md",
      digestText: null,
      totalCostUsd: 0,
      durationMs: Date.now() - startedAt,
      checksRan: [],
      checksErrored: [],
      errorMessage: `HEARTBEAT.md not found at ${heartbeatPath}`,
    };
  }
  const { checkIds, context } = parseHeartbeatMd(content);
  if (checkIds.length === 0) {
    return {
      status: "no-heartbeat-md",
      digestText: null,
      totalCostUsd: 0,
      durationMs: Date.now() - startedAt,
      checksRan: [],
      checksErrored: [],
      errorMessage: "HEARTBEAT.md present but contains no check IDs",
    };
  }

  // Step 2: dispatch checks in parallel
  const checkCtx: HandlerContext = {
    mountPath: opts.mountPath,
    threadId: opts.threadId,
    timeoutMs: checkTimeoutMs,
  };
  const settled = await Promise.all(
    checkIds.map(async (id) => ({ id, result: await dispatch(id, checkCtx) })),
  );
  const results: Record<string, CheckResult> = {};
  const checksErrored: string[] = [];
  for (const { id, result } of settled) {
    results[id] = result;
    if (result.status === "error" || result.status === "timeout") checksErrored.push(id);
  }

  // Step 3: spawn claude with --tools "Read,Glob,Grep" (Design A — no Bash)
  const prompt = buildUserPrompt(results, context);
  const argv = [
    claudeBin,
    ...buildClaudeArgv({
      prompt,
      sessionUuid: opts.sessionUuid,
      model,
      // Default true unless caller explicitly says it's a fresh session.
      // Production scheduler in poller.ts:digestDispatch passes false on
      // first fire (when UUID was just generated), true on subsequent
      // fires (when UUID was read from the session file).
      resumeExisting: opts.resumeExisting ?? true,
    }),
  ];

  // SIGTERM at sigTermMs (graceful — give claude time to flush --resume session
  // JSONL), SIGKILL at sigKillMs. Done via two timers + AbortController.
  const ctrl = new AbortController();
  let killEscalated = false;
  let termFired = false;
  const sigTermTimer = setTimeout(() => {
    termFired = true;
    try { proc?.kill?.("SIGTERM"); } catch { /* race ok */ }
  }, sigTermMs);
  const sigKillTimer = setTimeout(() => {
    killEscalated = true;
    ctrl.abort();
    try { proc?.kill?.("SIGKILL"); } catch { /* race ok */ }
  }, sigKillMs);

  let proc: ReturnType<ClaudeSpawnLike> | null = null;
  try {
    proc = spawn({
      cmd: argv,
      cwd: opts.mountPath,
      stdout: "pipe",
      stderr: "pipe",
      signal: ctrl.signal,
    });

    const exitCode = await proc.exited;
    clearTimeout(sigTermTimer);
    clearTimeout(sigKillTimer);

    if (killEscalated) {
      return {
        status: "timeout",
        digestText: null,
        totalCostUsd: 0,
        durationMs: Date.now() - startedAt,
        checksRan: checkIds,
        checksErrored,
        errorMessage: `claude exceeded ${sigKillMs}ms (SIGKILLed)`,
      };
    }

    if (exitCode !== 0 && !termFired) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      return {
        status: "error",
        digestText: null,
        totalCostUsd: 0,
        durationMs: Date.now() - startedAt,
        checksRan: checkIds,
        checksErrored,
        errorMessage: `claude exited ${exitCode}: ${stderr.trim().slice(0, 300)}`,
      };
    }

    // Step 4: parse stream-json
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    const { assistantText, totalCostUsd } = parseStreamJson(stdout);

    // Step 5: NOTHING_TO_REPORT gate
    const trimmed = assistantText.trim();
    if (NOTHING_TO_REPORT_RE.test(trimmed)) {
      return {
        status: "empty",
        digestText: null,
        totalCostUsd,
        durationMs: Date.now() - startedAt,
        checksRan: checkIds,
        checksErrored,
      };
    }
    if (trimmed.length === 0) {
      // Claude produced no text at all — treat as error so the operator can
      // notice. This is rarely a "successful empty"; an empty digest should
      // be NOTHING_TO_REPORT explicitly per the system prompt.
      return {
        status: "error",
        digestText: null,
        totalCostUsd,
        durationMs: Date.now() - startedAt,
        checksRan: checkIds,
        checksErrored,
        errorMessage: "claude produced empty assistant text (expected NOTHING_TO_REPORT or digest)",
      };
    }
    return {
      status: "sent",
      digestText: trimmed,
      totalCostUsd,
      durationMs: Date.now() - startedAt,
      checksRan: checkIds,
      checksErrored,
    };
  } finally {
    clearTimeout(sigTermTimer);
    clearTimeout(sigKillTimer);
    if (proc && proc.killed === false && proc.kill) {
      try { proc.kill(); } catch { /* race */ }
    }
  }
}
