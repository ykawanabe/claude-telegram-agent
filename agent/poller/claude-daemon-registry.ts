/**
 * ClaudeDaemonRegistry — manages one long-lived ClaudeDaemon per topic.
 *
 * Owns the full message lifecycle for Phase 4:
 *   - lazy spawn on first message
 *   - per-topic debounce (collapse rapid user sends into one claude turn)
 *   - mid-turn queue (next batch waits for current turn-end)
 *   - text streaming → onText callback (multi-message UX)
 *   - "released for terminal" state (β handoff for "Open in Terminal")
 *   - crash detection + automatic respawn with backoff
 *
 * Lifecycle state machine per topic:
 *
 *     idle ─enqueue─→ pending ─timer─→ inFlight ─turn-end─→ idle/pending
 *     idle ─release─→ released
 *     released ─reacquire─→ idle (flushes any queued messages)
 *     any ─crash─→ crashed ─enqueue─→ idle (respawn on next message)
 */
import { ClaudeDaemon, type ClaudeDaemonOptions, type TurnEndInfo, type CrashInfo } from "./claude-daemon";
import type { DaemonEvent, EventSink, ResourceRegistryPort } from "./contracts";

export interface RegistryOptions {
  /** Default 2000ms — collapse messages arriving within this window. */
  debounceMs?: number;
  /** Default 1500ms — when a message arrives mid-turn and auto-steer is on,
   *  wait this long (resetting on each further message) before interrupting,
   *  so a burst of follow-ups collapses into one interrupt. */
  interruptDebounceMs?: number;
  /** Returns true if mid-turn messages should auto-interrupt the running turn
   *  (debounced) rather than holding until turn-end. Read live at arm time so
   *  the poller's settings reload takes effect without reconstructing the
   *  registry. Default: always on. */
  autoSteerEnabled?: () => boolean;
  /** Override the claude binary path (tests inject the fake). */
  claudeBin?: string;
  /** Per-topic daemon options — called lazily to build cwd/uuid/etc. */
  daemonOptsFor: (threadId: string) => Omit<ClaudeDaemonOptions, "claudeBin">;
  /** Preferred Phase 0 registry observation boundary. Synchronous/nonthrowing;
   *  when present it replaces the six legacy callbacks below. */
  eventSink?: EventSink;
  /** Legacy callback surface retained for compatible construction in tests and
   *  downstream callers. Production wiring now uses eventSink. */
  onText?: (threadId: string, text: string) => void;
  /** Optional: called when a batch is flushed to claude (text already sent). */
  onFlush?: (threadId: string, combinedText: string) => void;
  /** Optional: turn-start callback — fired when a flushed batch is sent to the
   *  daemon (turn goes inFlight). Symmetric with onTurnEnd. Lets the poller
   *  (re-)assert the typing indicator on EVERY turn, so a steered continuation
   *  after a mid-turn interrupt re-arms typing — the interrupted turn's turn-end
   *  cleared the marker, and without this the bot keeps working with no
   *  "typing…" bubble (looks dead). */
  onTurnStart?: (threadId: string) => void;
  /** Optional: turn-end callback (post-result event) — cost logging. */
  onTurnEnd?: (threadId: string, info: TurnEndInfo) => void;
  /** Optional: backoff escalation cap. Default 60s. */
  maxBackoffMs?: number;
  /** Optional: how long a topic may sit "released" (β handoff to terminal)
   *  before an incoming message self-heals it back. Guards the orphaned-
   *  handoff failure (terminal died without signaling reacquire → topic stuck
   *  released → messages silently queued forever). Default 10min. The window
   *  must be long enough not to yank a daemon out from under a terminal the
   *  user is actively using. */
  releaseMaxMs?: number;
  /** Optional: inactivity watchdog for an inFlight turn. If the daemon emits
   *  no text and no turn-end/crash for this long, the turn is presumed wedged
   *  (the 2026-05-21 incident: daemon posted text then died without a result
   *  event → registry stuck inFlight). The watchdog kills the daemon so the
   *  crash path respawns. Reset on every text block (so a long-but-active turn
   *  is never killed). Default 5min. */
  inFlightTimeoutMs?: number;
  /** Optional: fired when the daemon can't be spawned at all (claude not on the
   *  launchd PATH, immediate start failure). Without it the user gets total
   *  silence — message queued, typing times out, no error ever reaches the chat.
   *  Lets the poller surface a one-shot notice. Fires per failed flush. */
  onSpawnFail?: (threadId: string) => void;
  /** Optional: fired ONCE when a topic hits `crashLoopThreshold` consecutive
   *  crashes with no healthy turn in between (a bad `/model`, a corrupt session
   *  JSONL that `--resume` rejects, an auth failure). The other half of the
   *  "bot silently stops replying" class — claude spawns fine but dies every
   *  turn. crashCount resets to 0 on any healthy turn-end. */
  onCrashLoop?: (threadId: string, crashCount: number) => void;
  /** Optional: consecutive-crash count that trips onCrashLoop. Default 3. */
  crashLoopThreshold?: number;
  /** Optional: post-interrupt escalation deadline. After we send an interrupt
   *  (auto-steer or /stop) we expect claude to emit a result → turn-end. But
   *  claude v2.1.150 frequently ACKs the interrupt (control_response:success)
   *  and then emits NO result — the turn wedges (verified live 2026-05-25, the
   *  "General stopped responding" incident). Relying on inFlightTimeoutMs (5min)
   *  to recover means 5 minutes of silence. So once an interrupt is sent we
   *  re-arm the watchdog with THIS much shorter deadline; if no turn-end arrives
   *  the wedged daemon is SIGKILLed → crash → respawn → queue flush. Trailing
   *  text from the aborting turn does NOT extend it (unlike the normal
   *  watchdog), so a steer recovers promptly. Default 12s. */
  interruptEscalateMs?: number;
}

type DaemonState = "idle" | "pending" | "inFlight" | "released" | "crashed";

interface DaemonHandle {
  daemon: ClaudeDaemon | null;
  state: DaemonState;
  /** Outstanding text pieces for the next batch. */
  queue: string[];
  /** Debounce timer (cleared if a new message arrives before fire). */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Exponential backoff on crash respawn. */
  backoffMs: number;
  /** Consecutive crashes with no healthy turn-end in between. Drives the
   *  onCrashLoop notice; reset to 0 on any healthy turn-end. */
  crashCount: number;
  /** Spawned count — exposed for tests to detect respawns. */
  spawnedCount: number;
  /** Wall-clock ms when releaseForTerminal was last called; null when not
   *  released. Drives the orphaned-handoff TTL self-heal. */
  releasedAt: number | null;
  /** Inactivity watchdog for the current inFlight turn (B2). Cleared on
   *  turn-end / crash / release / reset; reset on each text block. */
  inFlightTimer: ReturnType<typeof setTimeout> | null;
  /** Interrupt-debounce timer for mid-turn auto-steer. Cleared on
   *  turn-end / crash / release / reset / stop; reset on each mid-turn message. */
  interruptTimer: ReturnType<typeof setTimeout> | null;
  /** True from the moment an interrupt is sent until the next turn-end/crash.
   *  While set, armInFlightWatchdog uses the short interruptEscalateMs deadline
   *  and trailing text blocks do NOT extend it — so a wedged interrupt (claude
   *  ACKs but emits no result) is SIGKILLed within seconds instead of waiting
   *  out the 5-min inFlight watchdog. Cleared on turn-end / crash / release /
   *  reset. */
  postInterrupt: boolean;
  /** Wall-clock ms of the last activity on this topic (enqueue or turn-end).
   *  Drives the idle sweep (idleCandidates): a topic quiet longer than the
   *  configured threshold becomes eligible for evict (small session) or
   *  flush-memory + clear (large session). Measured from here. */
  lastActivityAt: number;
  /** True only during stopTurn()'s intentional teardown. The on('crash')
   *  handler checks it to treat the SIGTERM-driven close as a clean stop
   *  (no backoff escalation, no respawn schedule) rather than a real crash —
   *  same idea as the "released" guard, but for /stop. */
  stopping: boolean;
  /** One-shot resolver set by runTurnAndWait() while it awaits a specific
   *  turn's end. The turn-end handler fires + clears it so the caller's promise
   *  resolves. null when no one is waiting. */
  turnEndResolver: (() => void) | null;
}

export class ClaudeDaemonRegistry implements ResourceRegistryPort {
  private readonly opts: RegistryOptions;
  private readonly handles: Map<string, DaemonHandle> = new Map();

  constructor(opts: RegistryOptions) {
    this.opts = opts;
  }

  /** Route one registry observation through the new sink, falling back to the
   *  exact legacy callback for compatibility. Ordering and throw behavior are
   *  intentionally unchanged. */
  private emitEvent(event: DaemonEvent): void {
    if (this.opts.eventSink) {
      this.opts.eventSink.emit(event);
      return;
    }
    switch (event.kind) {
      case "text":
        this.opts.onText?.(event.threadId, event.text);
        return;
      case "flush":
        this.opts.onFlush?.(event.threadId, event.combinedText);
        return;
      case "turn-start":
        this.opts.onTurnStart?.(event.threadId);
        return;
      case "turn-end":
        this.opts.onTurnEnd?.(event.threadId, {
          costUsd: event.costUsd,
          sessionId: event.sessionId,
        });
        return;
      case "spawn-failed":
        this.opts.onSpawnFail?.(event.threadId);
        return;
      case "crash-loop":
        this.opts.onCrashLoop?.(event.threadId, event.crashCount);
        return;
    }
  }

  /** Total number of live daemons (state != released/crashed). */
  get daemonCount(): number {
    let n = 0;
    for (const h of this.handles.values()) {
      if (h.daemon && h.daemon.isAlive) n++;
    }
    return n;
  }

  /** Total spawn count across all topics, including respawns. Test hook. */
  get spawnedCount(): number {
    let n = 0;
    for (const h of this.handles.values()) n += h.spawnedCount;
    return n;
  }

  /** Inspect a topic's current state. */
  getStatus(threadId: string): DaemonState | "absent" {
    const h = this.handles.get(threadId);
    return h ? h.state : "absent";
  }

  /** Snapshot every topic's outstanding queue. Used by pair-switch teardown
   *  to preserve in-flight messages across registry replacement — without
   *  this, the user's pending text vanishes when their paired chat changes
   *  mid-conversation. Returned as `[threadId, queueCopy][]` tuples (queue
   *  arrays are copies, safe for the caller to mutate). */
  snapshotQueues(): Array<[string, string[]]> {
    const out: Array<[string, string[]]> = [];
    for (const [threadId, handle] of this.handles) {
      out.push([threadId, [...handle.queue]]);
    }
    return out;
  }

  /**
   * Enqueue a user message. Spawns the daemon if needed. The debounce
   * timer collapses rapid sends; mid-turn enqueues hold until turn-end.
   */
  enqueue(threadId: string, text: string): void {
    let handle = this.handles.get(threadId);
    if (!handle) {
      handle = {
        daemon: null,
        state: "idle",
        queue: [],
        debounceTimer: null,
        backoffMs: 0,
        crashCount: 0,
        spawnedCount: 0,
        releasedAt: null,
        inFlightTimer: null,
        interruptTimer: null,
        postInterrupt: false,
        lastActivityAt: Date.now(),
        stopping: false,
        turnEndResolver: null,
      };
      this.handles.set(threadId, handle);
    }
    handle.queue.push(text);
    // Activity stamp → keeps the idle-eviction sweep from reaping a topic the
    // user is actively messaging (the eviction clock restarts on every send).
    handle.lastActivityAt = Date.now();

    // If terminal is holding the daemon, the message normally just sits in the
    // queue until reacquireFromTerminal fires. BUT if it's been released
    // longer than releaseMaxMs, the terminal almost certainly died without
    // signaling reacquire (the orphaned-handoff incident 2026-05-21) — so
    // self-heal: reacquire now and let this message (plus any backlog) flush,
    // rather than swallowing it forever.
    if (handle.state === "released") {
      const maxMs = this.opts.releaseMaxMs ?? 10 * 60_000;
      if (handle.releasedAt != null && Date.now() - handle.releasedAt > maxMs) {
        void this.reacquireFromTerminal(threadId);
      }
      return;
    }

    // If a turn is in progress: with auto-steer on, arm (or reset) an
    // interrupt-debounce so a single steer fires after the window and a burst
    // of follow-ups collapses into one interrupt. With it off, hold the queue
    // until turn-end (legacy behavior).
    if (handle.state === "inFlight") {
      const autoSteer = this.opts.autoSteerEnabled ? this.opts.autoSteerEnabled() : true;
      if (autoSteer) this.armInterruptDebounce(threadId, handle);
      return;
    }

    this.armDebounce(threadId, handle);
  }

  /** Kill the topic's daemon for β handoff (Open in Terminal). Incoming
   *  messages queue silently until reacquireFromTerminal. */
  async releaseForTerminal(threadId: string): Promise<void> {
    const handle = this.handles.get(threadId);
    if (!handle) return;
    // Set "released" BEFORE awaiting daemon.stop() so the on('crash') handler
    // that fires during teardown sees the released state and doesn't flip
    // us to "crashed" — which would race with the post-await write of
    // "released" below and leave a stale state. Also stops new enqueues
    // from arming a debounce timer mid-teardown.
    handle.state = "released";
    handle.releasedAt = Date.now();
    handle.postInterrupt = false;
    if (handle.debounceTimer) {
      clearTimeout(handle.debounceTimer);
      handle.debounceTimer = null;
    }
    if (handle.inFlightTimer) {
      clearTimeout(handle.inFlightTimer);
      handle.inFlightTimer = null;
    }
    if (handle.interruptTimer) {
      clearTimeout(handle.interruptTimer);
      handle.interruptTimer = null;
    }
    if (handle.daemon) {
      // SIGTERM gives claude a chance to close the session lock file
      // cleanly — necessary so the user's TUI `claude --resume` doesn't
      // refuse with "Session ID already in use".
      await handle.daemon.stop("SIGTERM");
      handle.daemon = null;
    }
  }

  /** Respawn the daemon after the user closes their terminal. Flushes
   *  any queued messages that arrived during the released window. */
  async reacquireFromTerminal(threadId: string): Promise<void> {
    const handle = this.handles.get(threadId);
    if (!handle) return;
    handle.state = "idle";
    handle.releasedAt = null;
    // If there's queued work, arm the debounce now. Otherwise the
    // daemon stays unspawned until the next enqueue (lazy).
    if (handle.queue.length > 0) {
      this.armDebounce(threadId, handle);
    }
  }

  /** Fully reset a topic's state — stop the daemon, drop the queue, drop
   *  the handle entry entirely. Next enqueue lazy-spawns a fresh daemon
   *  using whatever options daemonOptsFor() returns at that moment (so
   *  callers can rotate session UUIDs etc. *before* the next message).
   *
   *  Distinct from releaseForTerminal: that one expects reacquire from a
   *  terminal handoff and preserves the queue. resetTopic is for /clear
   *  semantics — "throw the conversation away, restart with whatever the
   *  caller has just configured."
   *
   *  Pending queue is intentionally dropped (matches user expectation:
   *  /clear means "forget what was going on"). If the caller wants to
   *  preserve a message across the reset, they should re-enqueue it. */
  async resetTopic(threadId: string): Promise<void> {
    const handle = this.handles.get(threadId);
    if (!handle) return;
    if (handle.debounceTimer) {
      clearTimeout(handle.debounceTimer);
      handle.debounceTimer = null;
    }
    if (handle.inFlightTimer) {
      clearTimeout(handle.inFlightTimer);
      handle.inFlightTimer = null;
    }
    if (handle.interruptTimer) {
      clearTimeout(handle.interruptTimer);
      handle.interruptTimer = null;
    }
    if (handle.daemon) {
      await handle.daemon.stop("SIGTERM");
    }
    this.handles.delete(threadId);
  }

  /** Abort the in-flight turn for a topic WITHOUT discarding the session or
   *  queue. Mirrors the kill side of resetTopic but PRESERVES the handle and
   *  does NOT rotate the session UUID — the on-disk session is untouched, so
   *  the next enqueue lazy-respawns and --resumes the SAME conversation. Only
   *  the running turn is dropped.
   *
   *  Returns true if a turn was actually aborted, false if nothing was running
   *  (idle/pending/released/crashed/absent) — lets the caller pick the reply
   *  copy ("Stopped." vs "Nothing running to stop.").
   *
   *  Graceful by default: send an in-band interrupt control message (verified
   *  claude v2.1.150) so the subprocess STAYS ALIVE and the session continues —
   *  claude ends the turn (turn-end → idle) and the next message reuses the warm
   *  daemon. Falls back to SIGTERM→SIGKILL kill + lazy respawn if the daemon /
   *  stdin is unavailable or the interrupt write fails. The queue is PRESERVED
   *  across the stop in both paths. */
  async stopTurn(threadId: string): Promise<boolean> {
    const handle = this.handles.get(threadId);
    if (!handle) return false;
    if (handle.state !== "inFlight") return false;
    if (handle.debounceTimer) { clearTimeout(handle.debounceTimer); handle.debounceTimer = null; }
    if (handle.interruptTimer) { clearTimeout(handle.interruptTimer); handle.interruptTimer = null; }

    // Graceful path: interrupt over stdin, leave the subprocess alive. The
    // daemon's turn-end handler transitions inFlight → idle and re-arms the
    // debounce if the queue is non-empty.
    //
    // CRITICAL: do NOT clear the inFlight watchdog (clearInFlightTimer) here.
    // The graceful interrupt relies on the CLI emitting a result → turn-end.
    // If the interrupt is acked but no result ever arrives (a hung/old CLI),
    // the still-armed watchdog (inFlightTimer) is the ONLY thing that recovers
    // the topic — it kills the wedged daemon → crash → respawn. Clearing it
    // before interrupting reintroduces the 2026-05-21 stuck-inFlight incident.
    // turn-end clears the watchdog normally on the happy path.
    if (handle.daemon) {
      try {
        await handle.daemon.interrupt();
        // Arm the short post-interrupt escalation: if claude ACKs but emits no
        // result (the v2.1.150 wedge), the daemon is SIGKILLed → crash → respawn
        // within interruptEscalateMs instead of pinning the topic inFlight until
        // the 5-min watchdog. turn-end clears it on the happy (responsive) path.
        const h = this.handles.get(threadId);
        if (h && h.state === "inFlight") {
          h.postInterrupt = true;
          this.armInFlightWatchdog(threadId, h);
        }
        return true;
      } catch {
        // fall through to the kill fallback below
      }
    }

    // Fallback: SIGTERM + lazy respawn (the pre-graceful behavior). Only here
    // do we clear the watchdog — the SIGTERM-driven close guarantees recovery.
    this.clearInFlightTimer(handle);
    handle.postInterrupt = false;
    handle.stopping = true;
    if (handle.daemon) {
      await handle.daemon.stop("SIGTERM");
      handle.daemon = null;
    }
    handle.stopping = false;
    handle.state = "idle";
    handle.backoffMs = 0;
    handle.lastActivityAt = Date.now();
    if (handle.queue.length > 0) this.armDebounce(threadId, handle);
    return true;
  }

  /** Tear down all daemons. Called on poller graceful exit. */
  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const handle of this.handles.values()) {
      if (handle.debounceTimer) {
        clearTimeout(handle.debounceTimer);
        handle.debounceTimer = null;
      }
      if (handle.inFlightTimer) {
        clearTimeout(handle.inFlightTimer);
        handle.inFlightTimer = null;
      }
      if (handle.interruptTimer) {
        clearTimeout(handle.interruptTimer);
        handle.interruptTimer = null;
      }
      if (handle.daemon) {
        promises.push(handle.daemon.stop("SIGTERM"));
      }
    }
    await Promise.all(promises);
    this.handles.clear();
  }

  /** List topics that have sat quiescent for at least idleMs — the eligible
   *  set for the poller's idle sweep. PURE: no side effects, so the caller
   *  decides per-topic what to do (evict a small session, or flush-memory +
   *  clear a bloated one). Returns [] when idleMs <= 0 (feature disabled).
   *
   *  Only "idle" handles with an alive daemon and an empty queue are eligible —
   *  pending/inFlight/released/crashed are never returned, so a live turn or a
   *  β-handoff is never raced. */
  idleCandidates(idleMs: number): string[] {
    if (idleMs <= 0) return [];
    const now = Date.now();
    const out: string[] = [];
    for (const [threadId, h] of this.handles) {
      if (h.state !== "idle") continue;
      if (h.queue.length > 0) continue;
      if (!h.daemon || !h.daemon.isAlive) continue;
      if (now - h.lastActivityAt < idleMs) continue;
      out.push(threadId);
    }
    return out;
  }

  /** Return the oldest quiescent daemons that may be evicted to bring the
   *  warm-daemon count down to maxWarm. This is deliberately PURE: the poller
   *  performs the resets and logs them. Busy, queued, released, and crashed
   *  topics are never candidates, so capacity pressure cannot interrupt work.
   *  maxWarm <= 0 disables the cap. */
  overCapacityIdleCandidates(maxWarm: number): string[] {
    if (maxWarm <= 0) return [];

    let liveCount = 0;
    const idle: Array<{ threadId: string; lastActivityAt: number }> = [];
    for (const [threadId, h] of this.handles) {
      if (!h.daemon || !h.daemon.isAlive) continue;
      liveCount += 1;
      if (h.state !== "idle" || h.queue.length > 0) continue;
      idle.push({ threadId, lastActivityAt: h.lastActivityAt });
    }

    const overflow = liveCount - Math.floor(maxWarm);
    if (overflow <= 0) return [];
    idle.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return idle.slice(0, overflow).map(({ threadId }) => threadId);
  }

  /** True iff the topic is currently idle with an empty queue — the "still safe
   *  to clear?" check the idle sweep runs AFTER a memory-flush turn, so a real
   *  message that arrived mid-flush (→ pending/queued) aborts the clear. */
  isIdleEmpty(threadId: string): boolean {
    const h = this.handles.get(threadId);
    return !!h && h.state === "idle" && h.queue.length === 0;
  }

  /** Run ONE turn on a topic's already-alive idle daemon and wait for it to
   *  end. Used by the idle memory-flush (send a "save durable context" prompt,
   *  wait for the write, then the caller clears the session). Bypasses the
   *  debounce/queue — this is an out-of-band housekeeping turn, not user input.
   *
   *  Resolves:
   *    "completed" — the turn ended within timeoutMs
   *    "timeout"   — no turn-end before timeoutMs (the inactivity watchdog,
   *                  armed here, recovers a genuinely wedged daemon)
   *    "skipped"   — no handle, daemon not alive, or topic not idle (a real
   *                  turn is in progress — don't stomp it)
   *
   *  Never leaves the topic stuck: on timeout the watchdog SIGKILLs a wedged
   *  daemon (→ crash → respawn → idle); on a normal end the turn-end handler
   *  transitions back to idle. */
  async runTurnAndWait(
    threadId: string,
    text: string,
    timeoutMs: number,
  ): Promise<"completed" | "timeout" | "skipped"> {
    const handle = this.handles.get(threadId);
    if (!handle || !handle.daemon || !handle.daemon.isAlive) return "skipped";
    if (handle.state !== "idle" || handle.queue.length > 0) return "skipped";

    handle.state = "inFlight";
    // Stamp activity NOW so a flush that wedges (timeout → watchdog SIGKILL →
    // respawn idle) doesn't re-qualify on the next tick and retry-storm a paid
    // turn every ~5 min on the most expensive (bloated) session. This buys a
    // full idle-window cooldown between flush attempts. (Success deletes the
    // handle via resetTopic, so this only matters for the timeout/wedge path.)
    handle.lastActivityAt = Date.now();
    const ended = new Promise<void>((resolve) => { handle.turnEndResolver = resolve; });
    try {
      await handle.daemon.send(text);
    } catch {
      handle.turnEndResolver = null;
      handle.state = "idle";
      return "skipped";
    }
    // Arm the inactivity watchdog so a flush turn that truly wedges (no text,
    // no end) is SIGKILLed + respawned rather than pinning the topic inFlight.
    this.armInFlightWatchdog(threadId, handle);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([ended.then(() => "completed" as const), timedOut]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") handle.turnEndResolver = null; // stop waiting; watchdog owns recovery
    return result;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private armDebounce(threadId: string, handle: DaemonHandle): void {
    if (handle.debounceTimer) {
      clearTimeout(handle.debounceTimer);
    }
    handle.state = "pending";
    handle.debounceTimer = setTimeout(() => {
      void this.flush(threadId);
    }, this.opts.debounceMs ?? 2000);
  }

  /** Mid-turn auto-steer: after interruptDebounceMs of quiet, interrupt the
   *  running turn so the queued messages flush into the next turn (turn-end
   *  re-arms the debounce). Resetting on each call collapses bursts. */
  private armInterruptDebounce(threadId: string, handle: DaemonHandle): void {
    if (handle.interruptTimer) clearTimeout(handle.interruptTimer);
    handle.interruptTimer = setTimeout(() => {
      handle.interruptTimer = null;
      const h = this.handles.get(threadId);
      if (!h || h.state !== "inFlight" || !h.daemon) return;   // race: turn already ended
      void h.daemon.interrupt().then(() => {
        // Interrupt sent. claude may ACK but emit no result (v2.1.150 wedge) —
        // arm the short escalation so a non-responding interrupt is SIGKILLed +
        // respawned within seconds and the steered queue flushes, rather than
        // waiting out the 5-min inFlight watchdog. Re-check state: turn may have
        // ended between the await points.
        const h2 = this.handles.get(threadId);
        if (!h2 || h2.state !== "inFlight") return;
        h2.postInterrupt = true;
        this.armInFlightWatchdog(threadId, h2);
      }).catch(() => {
        // stdin closed mid-flight → the crash/respawn path will flush the queue.
      });
    }, this.opts.interruptDebounceMs ?? 1500);
  }

  private clearInFlightTimer(handle: DaemonHandle): void {
    if (handle.inFlightTimer) {
      clearTimeout(handle.inFlightTimer);
      handle.inFlightTimer = null;
    }
  }

  /** (Re)arm the inactivity watchdog for an inFlight turn. If it fires, the
   *  turn produced no text/turn-end/crash for inFlightTimeoutMs — presumed
   *  wedged (the 2026-05-21 incident: a daemon that posted text then died
   *  without a result event left the registry stuck inFlight forever). We
   *  SIGKILL the daemon; its 'close' → 'crash' event drives respawn through
   *  the existing crash handler (which also frees the session lock for the
   *  resume). Reset on every text block so an active turn is never killed. */
  private armInFlightWatchdog(threadId: string, handle: DaemonHandle): void {
    this.clearInFlightTimer(handle);
    // After an interrupt, recover on the short escalation deadline instead of
    // the 5-min inactivity watchdog — claude often ACKs the interrupt but never
    // emits a result, so the turn would otherwise sit wedged for 5 minutes.
    const timeoutMs = handle.postInterrupt
      ? (this.opts.interruptEscalateMs ?? 12_000)
      : (this.opts.inFlightTimeoutMs ?? 5 * 60_000);
    handle.inFlightTimer = setTimeout(() => {
      const h = this.handles.get(threadId);
      if (!h || h.state !== "inFlight") return;
      h.inFlightTimer = null;
      const wedged = h.daemon;
      if (wedged) {
        // SIGKILL (not SIGTERM): the daemon is wedged and won't honor a
        // graceful shutdown. The crash event recovers state + respawns.
        void wedged.stop("SIGKILL");
      } else {
        // No daemon object but stuck inFlight — recover directly.
        h.state = "crashed";
        h.backoffMs = 0;
        h.state = "idle";
        if (h.queue.length > 0) this.armDebounce(threadId, h);
      }
    }, timeoutMs);
  }

  private async flush(threadId: string): Promise<void> {
    const handle = this.handles.get(threadId);
    if (!handle || handle.queue.length === 0) return;
    handle.debounceTimer = null;

    // Spawn the daemon if not running.
    if (!handle.daemon || !handle.daemon.isAlive) {
      const ok = await this.spawn(threadId, handle);
      if (!ok) {
        handle.state = "crashed";
        // Surface the spawn failure — otherwise the user's message sits queued
        // in silence (typing times out, no error ever reaches the chat).
        this.emitEvent({ kind: "spawn-failed", threadId });
        return;
      }
    }

    // Combine queued text into one user event. Single newline between
    // entries reads naturally for "I'm sending a few thoughts" patterns;
    // multi-paragraph claude prompts use blank line. Single newline is
    // the safer default.
    const combined = handle.queue.join("\n");
    handle.queue = [];
    handle.state = "inFlight";

    try {
      this.emitEvent({ kind: "flush", threadId, combinedText: combined });
      await handle.daemon!.send(combined);
      // Turn is now in-flight — signal turn-start so the poller can (re-)assert
      // the typing indicator. Fires on EVERY turn, so a steered continuation
      // after a mid-turn interrupt re-arms typing (the interrupted turn-end
      // cleared the marker).
      this.emitEvent({ kind: "turn-start", threadId });
      // Start the inactivity watchdog: if the daemon emits no text and no
      // turn-end/crash before it fires, the turn is presumed wedged.
      this.armInFlightWatchdog(threadId, handle);
    } catch (err) {
      // Daemon went away between the alive-check and the write. Re-queue
      // the message so the user doesn't lose it, then rearm the debounce
      // so the respawn path actually fires — without rearm, the message
      // sits in the queue forever if no follow-up enqueue ever happens.
      handle.state = "crashed";
      handle.queue.unshift(combined);
      // Defer the rearm so the on('crash') handler (which may fire in the
      // same tick) finishes setting state first. The crash handler will
      // transition crashed→idle after backoff and arm-debounce; if a write
      // error fires before crash, we self-recover via the next tick.
      setTimeout(() => {
        const h = this.handles.get(threadId);
        if (!h) return;
        // Only rearm if state is still crashed (avoid double-arming if the
        // crash handler already armed during its backoff timer).
        if (h.state === "crashed" && h.queue.length > 0) {
          h.state = "idle";
          this.armDebounce(threadId, h);
        }
      }, 0);
    }
  }

  /** Create a fresh ClaudeDaemon, wire its events to registry callbacks,
   *  start it, and stash in the handle. Returns true on success. */
  private async spawn(threadId: string, handle: DaemonHandle): Promise<boolean> {
    const daemonOpts = this.opts.daemonOptsFor(threadId);
    const daemon = new ClaudeDaemon({
      ...daemonOpts,
      claudeBin: this.opts.claudeBin,
    });

    daemon.on("text", (text: string) => {
      // Activity → reset the inactivity watchdog so a long-but-active turn is
      // never killed (only true silence trips it). EXCEPTION: after an interrupt
      // (postInterrupt), trailing text from the aborting turn must NOT push the
      // escalation deadline back — we asked the turn to stop, so a steer should
      // recover promptly even if claude keeps dribbling out the old answer.
      const h = this.handles.get(threadId);
      if (h && h.state === "inFlight" && !h.postInterrupt) this.armInFlightWatchdog(threadId, h);
      this.emitEvent({ kind: "text", threadId, text });
    });

    daemon.on("turn-end", (info: TurnEndInfo) => {
      this.emitEvent({
        kind: "turn-end",
        threadId,
        costUsd: info.costUsd,
        sessionId: info.sessionId,
      });
      const h = this.handles.get(threadId);
      if (!h) return;
      this.clearInFlightTimer(h);
      h.postInterrupt = false; // turn ended → drop the escalation mode
      if (h.state === "released") return; // user yanked the daemon mid-turn
      // Healthy turn — reset crash backoff + the consecutive-crash counter.
      h.backoffMs = 0;
      h.crashCount = 0;
      h.state = "idle";
      // Idle clock starts now: the daemon just went quiescent. idleCandidates
      // measures from here.
      h.lastActivityAt = Date.now();
      // Wake any runTurnAndWait() awaiting THIS turn's end (e.g. the idle
      // memory-flush) before arming the next debounce.
      if (h.turnEndResolver) { const r = h.turnEndResolver; h.turnEndResolver = null; r(); }
      // Clear any pending interrupt-debounce BEFORE re-arming the next turn's
      // debounce: a surviving interruptTimer that fires after the queue re-arms
      // would interrupt the NEXT (unrelated) turn. Order matters here.
      if (h.interruptTimer) { clearTimeout(h.interruptTimer); h.interruptTimer = null; }
      // If more messages arrived while we were in-flight, arm next debounce.
      if (h.queue.length > 0) this.armDebounce(threadId, h);
    });

    daemon.on("crash", (info: CrashInfo) => {
      const h = this.handles.get(threadId);
      if (!h) return;
      this.clearInFlightTimer(h);
      h.postInterrupt = false;
      if (h.interruptTimer) { clearTimeout(h.interruptTimer); h.interruptTimer = null; }
      // Drop any runTurnAndWait resolver: the turn it awaited died with the
      // daemon. Leaving it set lets a LATER real turn's turn-end fire this
      // stale resolver → a spurious idle-clear right after the user's reply.
      // runTurnAndWait's own timeout still resolves it as "timeout".
      h.turnEndResolver = null;
      // Clean exit during release-for-terminal is expected; don't treat as crash.
      if (h.state === "released") return;
      // Intentional /stop teardown: stopTurn() owns the post-stop transition
      // and re-arming. Don't apply crash backoff or schedule a respawn here.
      if (h.stopping) { h.daemon = null; return; }
      h.daemon = null;
      h.state = "crashed";
      // A crash with no healthy turn since the last one → count it, and fire the
      // crash-loop notice exactly once when we cross the threshold (claude spawns
      // fine but dies every turn — bad /model, corrupt session JSONL, auth error).
      h.crashCount += 1;
      const crashThreshold = this.opts.crashLoopThreshold ?? 3;
      if (h.crashCount === crashThreshold) {
        this.emitEvent({ kind: "crash-loop", threadId, crashCount: h.crashCount });
      }
      // Schedule a respawn attempt with exponential backoff. If the queue
      // is non-empty, the respawn will flush; otherwise stays idle until
      // the next enqueue.
      const max = this.opts.maxBackoffMs ?? 60_000;
      h.backoffMs = h.backoffMs === 0 ? 500 : Math.min(h.backoffMs * 2, max);
      setTimeout(() => {
        const handle = this.handles.get(threadId);
        if (!handle) return;
        if (handle.state !== "crashed") return; // user did something in the meantime
        // Eager respawn if there's work to do; otherwise stay crashed and
        // let the next enqueue trigger spawn.
        if (handle.queue.length > 0) {
          handle.state = "idle";
          this.armDebounce(threadId, handle);
        } else {
          handle.state = "idle";
        }
      }, h.backoffMs);
    });

    try {
      await daemon.start();
    } catch {
      return false;
    }
    handle.daemon = daemon;
    handle.spawnedCount += 1;
    handle.state = "idle";
    return true;
  }
}
