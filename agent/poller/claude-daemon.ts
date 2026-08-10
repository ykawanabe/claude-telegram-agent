/**
 * ClaudeDaemon — long-lived per-topic claude subprocess (Phase 4).
 *
 * Spawns `claude -p --input-format stream-json --output-format stream-json
 * --resume <uuid>` and keeps it alive across turns. User messages arrive as
 * JSON events on stdin, model output arrives as JSON events on stdout. We
 * read the stdout stream line-by-line and emit:
 *   - 'text'      for each assistant text block (multi-message UX free)
 *   - 'turn-end'  for each `result` event (carries cost + session id)
 *   - 'crash'     when the subprocess exits non-zero (poller decides whether
 *                 to respawn with backoff)
 *
 * Why long-lived? Per-message subprocess (Phase 2 / claude-runner.ts) paid
 * cold-start each turn — MCP server respawn, session JSONL replay, hooks
 * load. The "always-on AI assistant" mental model needs claude to stay warm.
 * Verified 2026-05-19 that `claude -p` survives multiple turns when stdin
 * stays open and receives JSON events sequentially.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createTranscriptCursor, type TranscriptEvent } from "./transcript-cursor";

export interface TurnEndInfo {
  costUsd: number | null;
  sessionId: string | null;
}

export interface CrashInfo {
  code: number | null;
  signal: string | null;
}

export interface ClaudeDaemonOptions {
  /** Project directory for claude's cwd. */
  cwd: string;
  /** Per-topic session UUID. Omit to skip --session-id / --resume entirely
   *  (only useful in tests where the fake claude ignores the flag). */
  sessionUuid?: string;
  /** True if a JSONL transcript already exists → `--resume`; false → `--session-id`. */
  resumeExisting?: boolean;
  /** Absolute path to the --mcp-config JSON file. */
  mcpConfigPath?: string;
  /** Absolute path to a --settings file (e.g. bot-hooks.json). */
  settingsPath?: string;
  /** Optional --append-system-prompt content. */
  appendSystemPrompt?: string;
  /** Override the claude binary (tests point this at fixtures/fake-claude-daemon.sh). */
  claudeBin?: string;
  /** --effort level (low|medium|high|xhigh|max). Omit → claude uses the
   *  settings.json effortLevel default. */
  effort?: string;
  /** --model (alias like "opus"/"sonnet" or a full id). Omit → claude default. */
  model?: string;
  /** Extra env vars merged into the subprocess env. */
  env?: Record<string, string>;
}

export class ClaudeDaemon extends EventEmitter {
  private readonly opts: ClaudeDaemonOptions;
  private proc: ChildProcess | null = null;
  private alive = false;
  private readonly transcript = createTranscriptCursor();

  constructor(opts: ClaudeDaemonOptions) {
    super();
    this.opts = opts;
  }

  /** Spawn the subprocess. Resolves once the child is running (does NOT
   *  wait for any turn — that happens via send()). */
  async start(): Promise<void> {
    if (this.proc) throw new Error("ClaudeDaemon already started");
    const bin = this.opts.claudeBin ?? "claude";
    const argv = ClaudeDaemon.buildArgv({
      sessionUuid: this.opts.sessionUuid,
      resumeExisting: this.opts.resumeExisting ?? false,
      mcpConfigPath: this.opts.mcpConfigPath,
      settingsPath: this.opts.settingsPath,
      appendSystemPrompt: this.opts.appendSystemPrompt,
      effort: this.opts.effort,
      model: this.opts.model,
    });
    const proc = spawn(bin, argv, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.proc = proc;
    this.alive = true;
    const started = new Promise<void>((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", reject);
    });

    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      // Stderr is occasionally noisy (hook output, deprecation warnings).
      // Surface as a log-level event; callers decide whether to log.
      this.emit("stderr", chunk);
    });
    proc.on("error", () => {
      this.alive = false;
      // `error` is a special EventEmitter event which throws when nobody is
      // listening. start() owns spawn failures through `started`; later child
      // failures are followed by `close`, which emits the registry's crash
      // signal below.
    });
    proc.on("close", (code, signal) => {
      this.alive = false;
      // Distinguish a clean exit (code 0, no signal, after stop()) from a
      // crash (non-zero, or signal-killed without our request). Caller's
      // 'crash' handler decides whether to respawn.
      this.emit("crash", { code, signal });
    });

    try {
      await started;
    } catch (error) {
      this.alive = false;
      this.proc = null;
      throw error;
    }

    // Tiny delay so the subprocess has a moment to wire its stdio. Without
    // this, the first send() can race the child's stdin reader setup on
    // slow systems. 20ms is generous enough.
    await new Promise((r) => setTimeout(r, 20));
  }

  /** Returns whether the subprocess is currently running. */
  get isAlive(): boolean {
    return this.alive;
  }

  /** Send a user message. The text is wrapped in claude's expected
   *  stream-json input envelope. Throws if the daemon isn't running. */
  async send(text: string): Promise<void> {
    if (!this.proc || !this.alive || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("ClaudeDaemon is not running — call start() first (or respawn after a crash)");
    }
    const event = {
      type: "user",
      message: {
        role: "user",
        content: text,
      },
    };
    // Each JSON event is one line — newline terminator separates events.
    const wire = JSON.stringify(event) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.proc!.stdin!.write(wire, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Gracefully interrupt the in-flight turn via the stream-json control
   *  protocol. Unlike stop()/SIGTERM, the subprocess stays alive and the
   *  session continues — claude aborts the current turn and emits a
   *  result(subtype:error_during_execution). Verified against claude v2.1.150.
   *  No-op safety: throws if the daemon isn't running (caller decides fallback). */
  async interrupt(): Promise<void> {
    if (!this.proc || !this.alive || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("ClaudeDaemon is not running — cannot interrupt");
    }
    const wire = JSON.stringify({
      type: "control_request",
      request_id: randomUUID().slice(0, 8),
      request: { subtype: "interrupt" },
    }) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.proc!.stdin!.write(wire, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Stop the subprocess. Default SIGTERM gives claude a chance to close
   *  the session file lock cleanly; SIGKILL when terminal handoff (β) or
   *  user explicitly wants immediate teardown. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    if (!this.alive) {
      this.proc = null;
      return;
    }
    proc.kill(signal);
    // Wait for the close event so callers can rely on isAlive flipping
    // before they continue (e.g. "Open in Terminal" β handoff).
    if (this.alive) {
      await new Promise<void>((resolve) => {
        // Capture the SIGKILL escalation timer so it can be cleared on a
        // fast clean exit. Without clearTimeout, the timer fires harmlessly
        // 5s later (alive check is false), but it pins the Node event loop
        // open for that duration — under rapid pair-switch shutdowns this
        // stacks dozens of timers and delays process exit.
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        const onClose = () => {
          proc.off("close", onClose);
          if (killTimer) clearTimeout(killTimer);
          resolve();
        };
        proc.on("close", onClose);
        killTimer = setTimeout(() => {
          killTimer = null;
          if (this.alive) {
            try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          }
        }, 5000);
      });
    }
    this.proc = null;
  }

  /**
   * Accumulate stdout chunks and emit one event per complete JSON line.
   * stream-json is newline-delimited; chunks can land mid-line, so we
   * buffer until we see a newline.
   */
  private onStdout(chunk: string): void {
    for (const event of this.transcript.push(chunk)) {
      this.handleEvent(event);
    }
  }

  private handleEvent(event: TranscriptEvent): void {
    if (event.type === "assistant") {
      this.emit("text", event.text);
      return;
    }

    const info: TurnEndInfo = {
      costUsd: event.costUsd ?? null,
      sessionId: event.sessionId ?? null,
    };
    this.emit("turn-end", info);
    if (event.isError === true) this.emit("turn-error", { result: event.result ?? "" });
  }

  /**
   * Build the argv array for `claude -p --input-format stream-json
   * --output-format stream-json …`. Exposed so tests can assert flag
   * composition without spawning.
   */
  static buildArgv(opts: {
    sessionUuid?: string;
    resumeExisting: boolean;
    mcpConfigPath?: string;
    settingsPath?: string;
    appendSystemPrompt?: string;
    effort?: string;
    model?: string;
  }): string[] {
    const args: string[] = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",                           // required for stream-json output
      "--dangerously-skip-permissions",
    ];
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.mcpConfigPath) {
      // Note: deliberately NOT passing --strict-mcp-config. We MERGE the
      // per-topic telegram MCP with the user's own ~/.claude.json MCPs so
      // the bot can use Notion, browser, gmail, etc. that the user has
      // already installed for Claude Code. The pairing/user-id filter
      // (poller routeMessage) is the real security boundary — once it
      // holds, the daemon is "the user themselves typing on their phone"
      // and inherits the same MCP authority as the user's CLI.
      args.push("--mcp-config", opts.mcpConfigPath);
    }
    if (opts.settingsPath) {
      args.push("--settings", opts.settingsPath);
    }
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    if (opts.sessionUuid) {
      args.push(opts.resumeExisting ? "--resume" : "--session-id", opts.sessionUuid);
    }
    return args;
  }
}
