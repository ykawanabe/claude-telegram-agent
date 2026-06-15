/**
 * Agentic runner — spawns the gated `claude` that DOES the work for agentic 秘書 mode.
 *
 * Unlike the interactive daemon (long-lived, `--dangerously-skip-permissions`, fully
 * trusted) and the heartbeat runner (read-only `--tools Read,Glob,Grep`), this spawns a
 * tool-enabled `claude` with a PreToolUse hook (gate-hook.ts) as the autonomy gate:
 * reversible work runs silently; irreversible/outward work pauses for a Telegram
 * Approve/Edit/Reject. The hook fails closed.
 *
 * It is a SEPARATE ephemeral process (mirrors heartbeat-runner) so it never touches the
 * interactive daemon's state machine and the poller's own watchdog stays satisfied (the
 * poller keeps long-polling while this child runs and blocks on approvals).
 *
 * Streaming: assistant text is emitted via onText as it arrives, so the user watches the
 * agent work and the approval cards (sent by the poller's housekeep scan) interleave
 * naturally while the hook blocks mid-turn.
 *
 * This module decides HOW to run one agentic task. It does NOT decide when (the /do
 * command or the proactive heartbeat does) and does NOT send Telegram itself beyond the
 * onText callback the caller wires to reply().
 */

import { join } from "node:path";

export interface AgenticRunOpts {
  /** Project directory — claude's cwd AND the sandbox root the gate uses for in-mount checks. */
  readonly mountPath: string;
  /** Topic id ("dm" or numeric-as-string) — for the gate's approval routing + logs. */
  readonly threadId: string;
  /** Chat id the approval cards are delivered to. */
  readonly chatId: number;
  /** The task for the agent (the /do text, or the proactive finding to act on). */
  readonly task: string;
  /** Directory where the gate writes approval requests / reads decisions. */
  readonly approvalsDir: string;
  /** Absolute path to the generated agentic --settings file (wires gate-hook on PreToolUse). */
  readonly settingsPath: string;
  /** Per-topic session UUID for --resume continuity. */
  readonly sessionUuid: string;
  /** True → `--resume <uuid>`; false → `--session-id <uuid>` (first run creates it). */
  readonly resumeExisting: boolean;
  /** Absolute path to the --mcp-config JSON (same as the interactive daemon's). */
  readonly mcpConfigPath?: string;
  /** Per-approval wait budget (ms) the gate blocks before timing out. Default 240000 (4 min). */
  readonly approvalExpiryMs?: number;
  /** Audit log file (jsonl) the gate appends each decision to. */
  readonly logFile?: string;

  // Overridable / test seams
  readonly claudeBin?: string;       // default "claude"
  readonly model?: string;           // default: omit (claude default)
  /** Reasoning-effort level passed as `--effort` (low|medium|high|xhigh|max).
   *  Omit → claude's default (which may inherit the user's settings.json
   *  effortLevel — pin explicitly to control cost on scheduled runs). */
  readonly effort?: string;
  /** Replace the default secretary SYSTEM_PROMPT (e.g. the digest-only variant
   *  that suppresses open-ended exploration on unattended scheduled runs). */
  readonly systemPrompt?: string;
  /** Overall runner budget. SIGTERM at sigTermMs, SIGKILL at sigKillMs. Must exceed
   *  approvalExpiryMs so a legit approval wait isn't killed. Defaults 8min / 9min. */
  readonly sigTermMs?: number;
  readonly sigKillMs?: number;
  /** Called with each assistant text block as it streams (wire to reply()). */
  readonly onText?: (text: string) => void;
  readonly spawn?: AgenticSpawnLike;
  readonly hookScriptPath?: string;  // default: gate-hook.ts next to this file
}

export type AgenticStatus = "done" | "error" | "timeout";

export interface AgenticResult {
  readonly status: AgenticStatus;
  readonly finalText: string | null;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly errorMessage?: string;
}

/** Narrowest shape of Bun.spawn the runner uses (mirrors heartbeat-runner's seam). */
export interface AgenticSpawnLike {
  (opts: {
    cmd: string[];
    cwd: string;
    env: Record<string, string>;
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

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_EXPIRY_MS = 240_000;
const DEFAULT_SIGTERM_MS = 480_000;
const DEFAULT_SIGKILL_MS = 540_000;

const SYSTEM_PROMPT = [
  "You are the user's agentic secretary, acting on their computer to complete a delegated task.",
  "You have real tools. A safety gate sits in front of every tool call:",
  "  - Reversible, in-project, read-only actions run automatically.",
  "  - Irreversible or outward actions (push, merge, delete, send a message, spend, anything outside",
  "    the project, or a shell command it can't prove safe) PAUSE for the user's approval in their chat.",
  "When a tool call is paused you will see it allowed (possibly with edited parameters), or denied with",
  "a reason. If denied, adapt — do NOT try to route around the gate (e.g. via a different tool or shell",
  "trick). Treat a denial as the user's decision.",
  "Work in small, verifiable steps. Prefer reversible actions; reach for irreversible/outward ones only",
  "when the task truly needs them. Narrate briefly what you're doing and why so the user can follow.",
  "Telegram renders your text as plain text — no markdown, keep updates short. When finished, end with a",
  "one or two line summary of what you did and what (if anything) still needs the user.",
].join("\n");

/** Build the claude argv. One-shot task delivered as the positional `-p` prompt
 *  (no stdin plumbing needed); stream-json OUTPUT for live progress. The PreToolUse
 *  gate fires regardless of input format. Exported for tests. */
export function buildClaudeArgv(opts: {
  task: string;
  sessionUuid: string;
  resumeExisting: boolean;
  settingsPath: string;
  mcpConfigPath?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
}): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",         // the PreToolUse gate is the real boundary
    "--settings", opts.settingsPath,
    "--append-system-prompt", opts.systemPrompt ?? SYSTEM_PROMPT,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  args.push(opts.resumeExisting ? "--resume" : "--session-id", opts.sessionUuid);
  args.push(opts.task);                        // positional prompt, last
  return args;
}

/** Build the env the gate hook reads (inherited claude → hook child). Exported for tests. */
export function buildGateEnv(opts: {
  approvalsDir: string;
  mountPath: string;
  threadId: string;
  chatId: number;
  expiryMs: number;
  logFile?: string;
}): Record<string, string> {
  return {
    AGENTIC_APPROVALS_DIR: opts.approvalsDir,
    AGENTIC_MOUNT: opts.mountPath,
    AGENTIC_THREAD_ID: opts.threadId,
    AGENTIC_CHAT_ID: String(opts.chatId),
    AGENTIC_EXPIRY_MS: String(opts.expiryMs),
    ...(opts.logFile ? { AGENTIC_LOG_FILE: opts.logFile } : {}),
  };
}

interface StreamAccum { finalText: string; totalCostUsd: number; resultError: string | null; }

/** True when a resume failed because the session itself is unusable — the
 *  conversation file is gone, or it's pinned to a model that's now unavailable
 *  (e.g. an access-gated model). The cure is to drop the session pointer and
 *  start fresh, not to surface the error. Used by the poller's self-heal. */
export function isSessionUnusableError(msg?: string): boolean {
  if (!msg) return false;
  return /no conversation found/i.test(msg)
    || /is currently unavailable/i.test(msg)
    || /\bmodel\b.*(unavailable|not found|unknown|no longer)/i.test(msg);
}

/** Parse newline-delimited stream-json incrementally, emitting assistant text via onText. */
export function makeStreamHandler(onText?: (t: string) => void): {
  push: (chunk: string) => void;
  flush: () => StreamAccum;
} {
  let buf = "";
  let finalText = "";
  let totalCostUsd = 0;
  let resultError: string | null = null;
  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t) return;
    let e: any;
    try { e = JSON.parse(t); } catch { return; }
    if (!e || typeof e !== "object") return;
    if (e.type === "assistant") {
      for (const b of (e.message?.content ?? [])) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.length) {
          finalText = b.text;
          onText?.(b.text);
        }
      }
    } else if (e.type === "result") {
      if (typeof e.total_cost_usd === "number") totalCostUsd = e.total_cost_usd;
      // claude reports model-unavailable / rate-limit failures in the result
      // event (is_error:true, result:<reason>), NOT on stderr. Capture it so the
      // exit-code error message carries the real reason instead of being blank.
      if (e.is_error === true && typeof e.result === "string" && e.result) resultError = e.result;
    }
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf.trim()) { handleLine(buf); buf = ""; }
      return { finalText, totalCostUsd, resultError };
    },
  };
}

export async function runAgentic(opts: AgenticRunOpts): Promise<AgenticResult> {
  const startedAt = Date.now();
  const spawn = opts.spawn ?? (Bun.spawn as unknown as AgenticSpawnLike);
  const claudeBin = opts.claudeBin ?? DEFAULT_CLAUDE_BIN;
  const expiryMs = opts.approvalExpiryMs ?? DEFAULT_EXPIRY_MS;
  const sigTermMs = opts.sigTermMs ?? DEFAULT_SIGTERM_MS;
  const sigKillMs = opts.sigKillMs ?? DEFAULT_SIGKILL_MS;

  const argv = [
    claudeBin,
    ...buildClaudeArgv({
      task: opts.task,
      sessionUuid: opts.sessionUuid,
      resumeExisting: opts.resumeExisting,
      settingsPath: opts.settingsPath,
      mcpConfigPath: opts.mcpConfigPath,
      model: opts.model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
    }),
  ];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildGateEnv({
      approvalsDir: opts.approvalsDir,
      mountPath: opts.mountPath,
      threadId: opts.threadId,
      chatId: opts.chatId,
      expiryMs,
      logFile: opts.logFile,
    }),
  };

  const ctrl = new AbortController();
  let killEscalated = false;
  let termFired = false;
  const sigTermTimer = setTimeout(() => { termFired = true; try { proc?.kill?.("SIGTERM"); } catch {} }, sigTermMs);
  const sigKillTimer = setTimeout(() => { killEscalated = true; ctrl.abort(); try { proc?.kill?.("SIGKILL"); } catch {} }, sigKillMs);

  let proc: ReturnType<AgenticSpawnLike> | null = null;
  const handler = makeStreamHandler(opts.onText);
  try {
    proc = spawn({ cmd: argv, cwd: opts.mountPath, env, stdout: "pipe", stderr: "pipe", signal: ctrl.signal });

    // Drain stdout incrementally so onText fires live (the task is the positional
    // prompt in argv, so there is no stdin to feed). Capture the drain promise and
    // await it before flushing — otherwise proc.exited can resolve before the last
    // chunks are parsed and the final summary is lost.
    let drainPromise: Promise<void> = Promise.resolve();
    if (proc.stdout) {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      drainPromise = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            handler.push(dec.decode(value, { stream: true }));
          }
        } catch { /* aborted */ }
      })();
    }

    const exitCode = await proc.exited;
    await drainPromise;
    clearTimeout(sigTermTimer);
    clearTimeout(sigKillTimer);
    const { finalText, totalCostUsd, resultError } = handler.flush();

    if (killEscalated) {
      return { status: "timeout", finalText: finalText || null, totalCostUsd, durationMs: Date.now() - startedAt, errorMessage: `agentic run exceeded ${sigKillMs}ms` };
    }
    if (exitCode !== 0 && !termFired) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      // Prefer the result-event reason (model unavailable, rate limit, …); claude
      // leaves stderr empty for those, so falling back to stderr alone yields a
      // bare "claude exited 1:" the user can't act on.
      const detail = (resultError ?? "") || stderr.trim() || "no error detail on stderr";
      return { status: "error", finalText: finalText || null, totalCostUsd, durationMs: Date.now() - startedAt, errorMessage: `claude exited ${exitCode}: ${detail.slice(0, 300)}` };
    }
    return { status: "done", finalText: finalText || null, totalCostUsd, durationMs: Date.now() - startedAt };
  } catch (e) {
    return { status: "error", finalText: null, totalCostUsd: 0, durationMs: Date.now() - startedAt, errorMessage: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(sigTermTimer);
    clearTimeout(sigKillTimer);
    if (proc && proc.killed === false && proc.kill) { try { proc.kill(); } catch {} }
  }
}

/** Default gate-hook path (next to this module). */
export function defaultHookScriptPath(): string {
  return join(import.meta.dir, "gate-hook.ts");
}
