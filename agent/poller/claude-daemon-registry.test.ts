/**
 * Tests for ClaudeDaemonRegistry — the per-topic long-lived-daemon manager.
 *
 * Responsibilities under test:
 *   - lazy-spawn a ClaudeDaemon on first message for a topic
 *   - 2s debounce: collapse rapid user messages into a single claude turn
 *   - per-topic serialization (queue mid-turn)
 *   - text streaming to the caller's onText callback
 *   - "released for terminal" lifecycle (β handoff)
 *   - crash recovery via the on('crash') hook (with backoff handled inside)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeDaemonRegistry } from "./claude-daemon-registry";

const FIXTURE = join(import.meta.dir, "fixtures/fake-claude-daemon.sh");

describe("ClaudeDaemonRegistry basic dispatch", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("enqueue spawns a daemon on first message + streams text to onText", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,                       // fast debounce for tests
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: (_thread, t) => texts.push(t),
    });

    reg.enqueue("topic-42", "hello");
    await waitFor(() => texts.length > 0, 5000);

    expect(texts[0]).toBe("You said: hello");
    expect(reg.daemonCount).toBe(1);
  });

  test("subsequent messages reuse the warm daemon (no respawn)", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: (_thread, t) => texts.push(t),
    });

    reg.enqueue("topic-42", "first");
    await waitFor(() => texts.length >= 1, 5000);
    const firstSpawnCount = reg.spawnedCount;

    reg.enqueue("topic-42", "second");
    await waitFor(() => texts.length >= 2, 5000);

    // Same daemon used for both turns — spawn counter never advanced.
    expect(reg.spawnedCount).toBe(firstSpawnCount);
    expect(reg.daemonCount).toBe(1);
  });

  test("messages to different topics get separate daemons", async () => {
    const texts: Array<{ thread: string; text: string }> = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: (thread, t) => texts.push({ thread, text: t }),
    });

    reg.enqueue("topic-42", "from A");
    reg.enqueue("topic-99", "from B");
    await waitFor(() => texts.length >= 2, 5000);

    expect(reg.daemonCount).toBe(2);
    expect(texts.some((m) => m.thread === "topic-42" && m.text.includes("from A"))).toBe(true);
    expect(texts.some((m) => m.thread === "topic-99" && m.text.includes("from B"))).toBe(true);
  });

  test("onTurnStart fires once per turn (typing-indicator re-arm signal)", async () => {
    const starts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
      onTurnStart: (t) => starts.push(t),
      autoSteerEnabled: () => false, // pure sequential turns, no mid-turn interrupt
    });

    // Two sequential turns → onTurnStart must fire once per turn. This is the
    // property that fixes the steered-turn typing bug: every (re)started turn
    // re-asserts typing, so a mid-turn interrupt can't leave the bubble off.
    reg.enqueue("topic-42", "first");
    await waitFor(() => starts.length >= 1, 5000);
    reg.enqueue("topic-42", "second");
    await waitFor(() => starts.length >= 2, 5000);

    expect(starts).toEqual(["topic-42", "topic-42"]);
  });
});

describe("ClaudeDaemonRegistry debounce", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("rapid consecutive enqueues collapse into one turn (with combined text)", async () => {
    const sentToDaemon: string[] = [];
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 300,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: (_t, s) => texts.push(s),
      onFlush: (_t, combinedText) => sentToDaemon.push(combinedText),
    });

    reg.enqueue("topic-42", "first part");
    reg.enqueue("topic-42", "second part");
    reg.enqueue("topic-42", "third part");

    // Wait past debounce window so the flush fires.
    await waitFor(() => sentToDaemon.length > 0, 2000);
    await waitFor(() => texts.length > 0, 5000);

    expect(sentToDaemon.length).toBe(1);
    // Combined text contains all three parts.
    expect(sentToDaemon[0]).toContain("first part");
    expect(sentToDaemon[0]).toContain("second part");
    expect(sentToDaemon[0]).toContain("third part");
    // And only one assistant reply for the whole batch.
    expect(texts.length).toBe(1);
  });

  test("enqueue mid-turn defers the next flush until the turn completes", async () => {
    const sentToDaemon: string[] = [];
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "slow" } }),
      onText: (_t, s) => texts.push(s),
      onFlush: (_t, combinedText) => sentToDaemon.push(combinedText),
    });

    // Slow fake claude takes ~1s per turn. Send msg 1, then msg 2 immediately —
    // msg 2 should NOT be sent to claude until msg 1's turn finishes.
    reg.enqueue("topic-42", "msg one");
    await waitFor(() => sentToDaemon.length >= 1, 5000);
    expect(sentToDaemon[0]).toContain("msg one");

    reg.enqueue("topic-42", "msg two");
    // Verify msg 2 doesn't fire while turn 1 still in progress.
    await new Promise((r) => setTimeout(r, 200));
    expect(sentToDaemon.length).toBe(1); // still just msg one

    // Wait for first turn to finish + debounce window for msg 2. Generous
    // ceiling because the fake-claude-daemon shell fixture spawns python3
    // for JSON escaping, and python3's cold-start on macOS under load can
    // stretch each turn well past the "slow"-mode nominal ~1s. Don't
    // tighten this without understanding the fixture's load envelope.
    await waitFor(() => sentToDaemon.length >= 2, 15000);
    expect(sentToDaemon[1]).toContain("msg two");
  });
});

describe("ClaudeDaemonRegistry terminal handoff (β)", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("releaseForTerminal kills daemon + queues incoming messages", async () => {
    const sentToDaemon: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
      onFlush: (_t, combinedText) => sentToDaemon.push(combinedText),
    });

    // Spawn the daemon.
    reg.enqueue("topic-42", "boot");
    await waitFor(() => sentToDaemon.length >= 1, 5000);

    await reg.releaseForTerminal("topic-42");
    expect(reg.getStatus("topic-42")).toBe("released");
    expect(reg.daemonCount).toBe(0);

    // Messages during release-for-terminal go into the queue but DON'T fire.
    reg.enqueue("topic-42", "while terminal open");
    await new Promise((r) => setTimeout(r, 300));
    expect(sentToDaemon.length).toBe(1); // unchanged

    // Reacquire respawns daemon + flushes queued messages.
    await reg.reacquireFromTerminal("topic-42");
    await waitFor(() => sentToDaemon.length >= 2, 5000);
    expect(sentToDaemon[1]).toContain("while terminal open");
  });
});

describe("ClaudeDaemonRegistry resetTopic (/clear semantics)", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("resetTopic stops the daemon, drops queue, removes handle (next enqueue lazy-spawns)", async () => {
    let optsCalls = 0;
    const sentToDaemon: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => {
        optsCalls++;
        return { cwd: "/tmp" };
      },
      onText: () => {},
      onFlush: (_t, combinedText) => sentToDaemon.push(combinedText),
    });

    // Spawn the daemon for the topic.
    reg.enqueue("topic-42", "first turn");
    await waitFor(() => sentToDaemon.length >= 1, 5000);
    expect(reg.daemonCount).toBe(1);
    expect(optsCalls).toBe(1);

    // Enqueue something that's still pending (in queue or in flight).
    reg.enqueue("topic-42", "should be dropped by reset");

    // Reset: daemon stopped, queue dropped, handle cleared.
    await reg.resetTopic("topic-42");
    expect(reg.getStatus("topic-42")).toBe("absent");
    expect(reg.daemonCount).toBe(0);

    // Next enqueue must lazy-spawn a NEW daemon — daemonOptsFor called again.
    reg.enqueue("topic-42", "fresh start");
    await waitFor(() => sentToDaemon.length >= 2, 5000);
    expect(optsCalls).toBe(2);
    expect(sentToDaemon[1]).toContain("fresh start");
    expect(sentToDaemon[1]).not.toContain("should be dropped");
  });

  test("resetTopic on unknown thread is a no-op", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    await reg.resetTopic("never-existed");
    expect(reg.getStatus("never-existed")).toBe("absent");
  });
});

describe("ClaudeDaemonRegistry crash recovery", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("daemon crash triggers automatic respawn on next enqueue (lazy)", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "crash-on-turn-2" } }),
      onText: (_t, s) => texts.push(s),
    });

    reg.enqueue("topic-42", "turn 1");
    await waitFor(() => texts.length >= 1, 5000);
    const initialSpawnCount = reg.spawnedCount;

    // Turn 2 makes the fake claude exit 1 after sending its reply.
    reg.enqueue("topic-42", "turn 2 will crash");
    await waitFor(() => texts.length >= 2, 5000);

    // Wait for the crash to settle (state flips to "crashed").
    await waitFor(() => reg.getStatus("topic-42") === "crashed" || reg.getStatus("topic-42") === "idle", 3000);

    // Now the NEXT enqueue should trigger a respawn. Lazy by design —
    // an idle assistant doesn't burn CPU in a respawn loop when claude
    // code is genuinely broken (network down, subscription suspended, etc.).
    reg.enqueue("topic-42", "after crash");
    await waitFor(() => reg.spawnedCount > initialSpawnCount, 5000);

    expect(reg.spawnedCount).toBeGreaterThan(initialSpawnCount);
  });

  // Note: a missing `claude` binary does NOT make daemon.start() throw (Node's
  // spawn surfaces ENOENT async as a 'close'/'error' → 'crash'), so the real
  // "claude is broken" failure mode is the crash-loop below, not onSpawnFail.
  // onSpawnFail stays wired as a defensive hook for the rare start()-throws case.
  test("onCrashLoop fires exactly once after crashLoopThreshold consecutive crashes", async () => {
    let loopFired = 0;
    let loopCount = 0;
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 30,
      maxBackoffMs: 100,                 // short respawn backoff so the test is fast
      crashLoopThreshold: 3,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "crash-always" } }),
      onText: () => {},
      onCrashLoop: (_t, n) => { loopFired++; loopCount = n; },
    });
    // Each message: spawn → send → the fake exits before turn-end → crash with no
    // healthy turn to reset the counter. Gate each re-enqueue on the previous
    // daemon having spawned-then-left inFlight (i.e. crashed); the 3rd crash
    // crosses the threshold and fires the notice once.
    for (let i = 1; i <= 3; i++) {
      reg!.enqueue("topic-42", `m${i}`);
      await waitFor(() => reg!.spawnedCount >= i, 5000);
      await waitFor(() => reg!.getStatus("topic-42") !== "inFlight", 3000);
    }
    await waitFor(() => loopFired > 0, 4000);
    expect(loopFired).toBe(1);   // exactly once, at the threshold (not on crash 4, 5…)
    expect(loopCount).toBe(3);
  });
});

describe("ClaudeDaemonRegistry self-heal (incident 2026-05-21)", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("orphaned 'released' topic self-heals on enqueue after releaseMaxMs (terminal died, never reacquired)", async () => {
    const sentToDaemon: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      releaseMaxMs: 200,                    // short orphan TTL for the test
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
      onFlush: (_t, combined) => sentToDaemon.push(combined),
    });

    // Spawn, then release for terminal (Open in Terminal). No reacquire ever
    // arrives — the real incident: the .ack file lingered after the terminal
    // claude exited, so the poller never signaled reacquire.
    reg.enqueue("topic-42", "boot");
    await waitFor(() => sentToDaemon.length >= 1, 5000);
    await reg.releaseForTerminal("topic-42");
    expect(reg.getStatus("topic-42")).toBe("released");

    // A message arriving BEFORE the TTL stays queued and does NOT fire — the
    // terminal might be legitimately in use; we don't yank the daemon back.
    reg.enqueue("topic-42", "early");
    await new Promise((r) => setTimeout(r, 100));
    expect(sentToDaemon.length).toBe(1);
    expect(reg.getStatus("topic-42")).toBe("released");

    // Past the TTL the orphan is assumed abandoned: the next message
    // self-heals (auto-reacquire) and flushes the backlog instead of
    // swallowing it forever.
    await new Promise((r) => setTimeout(r, 200));
    reg.enqueue("topic-42", "after ttl");
    await waitFor(() => sentToDaemon.length >= 2, 5000);
    expect(sentToDaemon[1]).toContain("early");
    expect(sentToDaemon[1]).toContain("after ttl");
  });

  test("inFlight turn that goes silent (no turn-end, no crash) self-heals via inactivity watchdog", async () => {
    const sentToDaemon: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      inFlightTimeoutMs: 300,               // short inactivity window for the test
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      onText: () => {},
      onFlush: (_t, c) => sentToDaemon.push(c),
    });

    // Turn 1: daemon posts text then hangs with no result event. The registry
    // enters inFlight and — without the watchdog — stays stuck there forever
    // (the General incident: text posted as msg 3012, no turn-end recorded).
    // Gate on onFlush (fires synchronously when the turn is dispatched) rather
    // than on a text event, so the test doesn't race the daemon's stdout.
    reg.enqueue("topic-42", "first");
    await waitFor(() => sentToDaemon.length >= 1, 5000);
    expect(reg.getStatus("topic-42")).toBe("inFlight");
    const spawnsBefore = reg.spawnedCount;

    // Queue a follow-up while inFlight. After inFlightTimeoutMs of silence the
    // watchdog kills the wedged daemon; the crash path respawns and flushes
    // the backlog.
    reg.enqueue("topic-42", "second");
    await waitFor(() => reg.spawnedCount > spawnsBefore, 8000);
    await waitFor(() => sentToDaemon.length >= 2, 8000);
    expect(sentToDaemon[1]).toContain("second");
  });
});

describe("ClaudeDaemonRegistry idleCandidates", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  // Drive a topic to a quiescent "idle" state (daemon spawned, turn finished).
  async function spawnIdle(r: ClaudeDaemonRegistry, thread: string): Promise<void> {
    r.enqueue(thread, "hello");
    await waitFor(() => r.getStatus(thread) === "idle" && r.daemonCount >= 1, 5000);
  }

  test("lists a topic idle past the threshold — WITHOUT evicting it", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    await spawnIdle(reg, "topic-42");
    expect(reg.daemonCount).toBe(1);

    // Let the idle clock advance well past a tiny threshold.
    await new Promise((r) => setTimeout(r, 50));
    expect(reg.idleCandidates(10)).toEqual(["topic-42"]);

    // Pure: the daemon is still alive and idle (caller decides what to do).
    expect(reg.daemonCount).toBe(1);
    expect(reg.getStatus("topic-42")).toBe("idle");
  });

  test("does NOT list a topic before the threshold elapses", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    await spawnIdle(reg, "topic-42");
    // 10s threshold — the daemon has been idle for only milliseconds.
    expect(reg.idleCandidates(10_000)).toEqual([]);
  });

  test("idleMs <= 0 returns [] (feature disabled)", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    await spawnIdle(reg, "topic-42");
    await new Promise((r) => setTimeout(r, 50));
    expect(reg.idleCandidates(0)).toEqual([]);
    expect(reg.idleCandidates(-1)).toEqual([]);
  });

  test("never lists a topic with queued / in-flight work", async () => {
    const sentToDaemon: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      onText: () => {},
      onFlush: (_t, c) => sentToDaemon.push(c),
    });
    reg.enqueue("topic-42", "first");
    await waitFor(() => sentToDaemon.length >= 1, 5000);
    expect(reg.getStatus("topic-42")).toBe("inFlight");
    // Even with a 0ms threshold, an inFlight turn is off-limits.
    expect(reg.idleCandidates(1)).toEqual([]);
  });
});

describe("ClaudeDaemonRegistry overCapacityIdleCandidates", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  async function spawnIdle(r: ClaudeDaemonRegistry, thread: string): Promise<void> {
    r.enqueue(thread, "hello");
    await waitFor(() => r.getStatus(thread) === "idle", 5000);
  }

  test("returns the oldest idle daemon needed to satisfy the cap", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 20,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    await spawnIdle(reg, "oldest");
    await new Promise((r) => setTimeout(r, 10));
    await spawnIdle(reg, "middle");
    await new Promise((r) => setTimeout(r, 10));
    await spawnIdle(reg, "newest");

    expect(reg.daemonCount).toBe(3);
    expect(reg.overCapacityIdleCandidates(2)).toEqual(["oldest"]);
    expect(reg.overCapacityIdleCandidates(1)).toEqual(["oldest", "middle"]);
  });

  test("never returns busy work and maxWarm <= 0 disables the cap", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 20,
      daemonOptsFor: (thread) => ({
        cwd: "/tmp",
        env: thread === "busy" ? { FAKE_CLAUDE_MODE: "hang-no-result" } : undefined,
      }),
      onText: () => {},
    });
    await spawnIdle(reg, "idle");
    reg.enqueue("busy", "work");
    await waitFor(() => reg!.getStatus("busy") === "inFlight", 5000);

    expect(reg.overCapacityIdleCandidates(1)).toEqual(["idle"]);
    expect(reg.overCapacityIdleCandidates(0)).toEqual([]);
  });
});

describe("ClaudeDaemonRegistry isIdleEmpty", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("true only when the topic is idle with an empty queue", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    expect(reg.isIdleEmpty("absent")).toBe(false);   // no handle
    reg.enqueue("topic-42", "hi");
    await waitFor(() => reg!.getStatus("topic-42") === "idle", 5000);
    expect(reg.isIdleEmpty("topic-42")).toBe(true);  // idle, empty
  });
});

describe("ClaudeDaemonRegistry runTurnAndWait", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  async function spawnIdle(r: ClaudeDaemonRegistry, thread: string): Promise<void> {
    r.enqueue(thread, "hello");
    await waitFor(() => r.getStatus(thread) === "idle" && r.daemonCount >= 1, 5000);
  }

  test("sends a turn and resolves 'completed' on turn-end", async () => {
    const sent: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
      onFlush: (_t, c) => sent.push(c),
    });
    await spawnIdle(reg, "topic-42");
    const result = await reg.runTurnAndWait("topic-42", "flush your memory", 5000);
    expect(result).toBe("completed");
    expect(reg.getStatus("topic-42")).toBe("idle"); // back to idle after the turn
  });

  test("resolves 'timeout' when the turn never ends", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      // hang-on-turn-2: turn 1 (spawnIdle) completes → idle; turn 2 (the flush)
      // posts text then never ends → runTurnAndWait must time out.
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-on-turn-2" } }),
      // High watchdog so it doesn't kill the daemon during the short test timeout.
      inFlightTimeoutMs: 60_000,
      onText: () => {},
    });
    await spawnIdle(reg, "topic-42");
    const result = await reg.runTurnAndWait("topic-42", "flush", 300);
    expect(result).toBe("timeout");
  });

  test("resolves 'skipped' for an absent or non-idle topic", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    expect(await reg.runTurnAndWait("never-seen", "x", 1000)).toBe("skipped");
  });

  test("a timed-out flush bumps activity so the topic does NOT immediately re-qualify (cooldown)", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-on-turn-2" } }),
      inFlightTimeoutMs: 60_000, // don't let the watchdog kill during the test
      onText: () => {},
    });
    await spawnIdle(reg, "topic-42");
    // Idle long enough to qualify against a tiny threshold...
    await new Promise((r) => setTimeout(r, 30));
    expect(reg.idleCandidates(10)).toEqual(["topic-42"]);
    // ...but a flush attempt times out and re-stamps activity.
    expect(await reg.runTurnAndWait("topic-42", "flush", 200)).toBe("timeout");
    // Topic is inFlight now (turn never ended) AND its idle clock just reset —
    // either way it must NOT be an idle candidate, so no retry-storm.
    expect(reg.idleCandidates(10)).toEqual([]);
  });
});

describe("ClaudeDaemonRegistry stopTurn", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("stopTurn gracefully interrupts: daemon stays warm, topic idle, queue preserved", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      inFlightTimeoutMs: 60_000,
      onText: (_t, s) => texts.push(s),
    });

    reg.enqueue("topic-42", "long running");
    await waitFor(() => texts.length >= 1, 5000);
    expect(reg.getStatus("topic-42")).toBe("inFlight");

    const spawnsBefore = reg.spawnedCount;
    const stopped = await reg.stopTurn("topic-42");
    expect(stopped).toBe(true);
    await waitFor(() => reg!.getStatus("topic-42") === "idle", 5000);
    expect(reg.daemonCount).toBe(1);                 // subprocess SURVIVES (graceful)

    reg.enqueue("topic-42", "after stop");
    await waitFor(() => texts.some((t) => t.includes("after stop")), 5000);
    expect(reg.spawnedCount).toBe(spawnsBefore);     // reused warm daemon, NOT respawned
  });

  test("stopTurn returns false when nothing is running (idle topic)", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    reg.enqueue("topic-7", "hi");
    await waitFor(() => reg!.getStatus("topic-7") === "idle", 5000); // turn finished
    expect(await reg.stopTurn("topic-7")).toBe(false);
  });

  test("stopTurn returns false for an absent topic", async () => {
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp" }),
      onText: () => {},
    });
    expect(await reg.stopTurn("never-seen")).toBe(false);
  });

  test("messages queued during the in-flight turn survive the stop", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      inFlightTimeoutMs: 60_000,
      onText: (_t, s) => texts.push(s),
    });

    reg.enqueue("topic-42", "first");
    await waitFor(() => texts.length >= 1, 5000);          // in-flight
    reg.enqueue("topic-42", "queued during turn");          // sits in the queue

    expect(await reg.stopTurn("topic-42")).toBe(true);
    // The preserved queue flushes on respawn → the queued message is processed.
    await waitFor(() => texts.some((t) => t.includes("queued during turn")), 5000);
  });

  test("stopTurn falls back to kill-respawn when the daemon stdin is gone", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      inFlightTimeoutMs: 60_000,
      onText: (_t, s) => texts.push(s),
    });
    reg.enqueue("topic-42", "long running");
    await waitFor(() => texts.length >= 1, 5000);

    // Simulate a dead-stdin daemon: force interrupt() to reject.
    const handle = (reg as any).handles.get("topic-42");
    handle.daemon.interrupt = async () => { throw new Error("stdin closed"); };

    expect(await reg.stopTurn("topic-42")).toBe(true);
    await waitFor(() => reg!.getStatus("topic-42") === "idle", 5000);
    expect(reg.daemonCount).toBe(0);                 // killed (fallback path)
  });
});

describe("ClaudeDaemonRegistry auto-steer (mid-turn interrupt)", () => {
  let reg: ClaudeDaemonRegistry | null = null;
  afterEach(async () => { if (reg) { await reg.shutdown(); reg = null; } });

  test("a mid-turn message interrupts and is processed in the next turn", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      interruptDebounceMs: 100,
      autoSteerEnabled: () => true,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      inFlightTimeoutMs: 60_000,
      onText: (_t, s) => texts.push(s),
    });
    reg.enqueue("topic-42", "browse the site");
    await waitFor(() => texts.length >= 1, 5000);      // inFlight (hung turn)
    expect(reg.getStatus("topic-42")).toBe("inFlight");

    reg.enqueue("topic-42", "no, click the other link");  // mid-turn steer
    // After interruptDebounceMs the registry interrupts → fixture emits result
    // → turn-end → batched message flushes as the next turn.
    await waitFor(() => texts.some((t) => t.includes("no, click the other link")), 5000);
  });

  test("rapid mid-turn messages collapse into ONE interrupt (batched)", async () => {
    let interruptCount = 0;
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      interruptDebounceMs: 150,
      autoSteerEnabled: () => true,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      inFlightTimeoutMs: 60_000,
      onText: (_t, s) => texts.push(s),
    });
    reg.enqueue("topic-42", "start");
    await waitFor(() => texts.length >= 1, 5000);
    const handle = (reg as any).handles.get("topic-42");
    const realInterrupt = handle.daemon.interrupt.bind(handle.daemon);
    handle.daemon.interrupt = async () => { interruptCount++; return realInterrupt(); };

    reg.enqueue("topic-42", "msg A");
    reg.enqueue("topic-42", "msg B");   // resets the interrupt-debounce
    reg.enqueue("topic-42", "msg C");
    await waitFor(() => texts.some((t) => t.includes("msg")), 5000);
    expect(interruptCount).toBe(1);     // one interrupt for the whole burst
  });

  test("interrupt that produces NO result still recovers fast (real-claude wedge)", async () => {
    // Reproduces the 2026-05-25 General-not-responding incident: real claude
    // v2.1.150 ACKs the interrupt control_request (control_response:success) but
    // frequently emits NO result → the turn wedges. Before the post-interrupt
    // escalation, the ONLY recovery was the 5-min inFlight watchdog → 5 min of
    // silence. The short escalation (interruptEscalateMs) must SIGKILL → respawn
    // → flush the steered message instead.
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      interruptDebounceMs: 80,
      interruptEscalateMs: 150,             // short post-interrupt deadline
      inFlightTimeoutMs: 60_000,            // long: must NOT be the recovery path
      autoSteerEnabled: () => true,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result", INTERRUPT_NO_RESULT: "1" } }),
      onText: (_t, s) => texts.push(s),
    });
    reg.enqueue("topic-42", "start");
    await waitFor(() => texts.length >= 1, 5000);          // inFlight (hung turn)
    expect(reg.getStatus("topic-42")).toBe("inFlight");
    const firstSpawn = reg.spawnedCount;

    reg.enqueue("topic-42", "steer me");                   // mid-turn → interrupt (no result) → escalate
    // Escalation SIGKILLs the wedged daemon → crash → respawn → flush "steer me".
    await waitFor(() => texts.some((t) => t.includes("steer me")), 5000);
    expect(reg.spawnedCount).toBeGreaterThan(firstSpawn);  // respawned, not stuck
  });

  test("stopTurn recovers when the graceful interrupt wedges (no result)", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      interruptEscalateMs: 150,
      inFlightTimeoutMs: 60_000,
      autoSteerEnabled: () => true,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result", INTERRUPT_NO_RESULT: "1" } }),
      onText: (_t, s) => texts.push(s),
    });
    reg.enqueue("topic-42", "start");
    await waitFor(() => texts.length >= 1, 5000);
    expect(reg.getStatus("topic-42")).toBe("inFlight");

    await reg.stopTurn("topic-42");                        // graceful interrupt → wedges (no result)
    // Without escalation this stays inFlight for 60s; with it, SIGKILL → crash →
    // idle (queue empty → lazy, next message respawns). The daemon is gone.
    await waitFor(() => reg.getStatus("topic-42") === "idle", 5000);
    expect(reg.daemonCount).toBe(0);
  });

  test("autoSteerEnabled=false keeps the legacy hold-until-turn-end behavior", async () => {
    const texts: string[] = [];
    reg = new ClaudeDaemonRegistry({
      claudeBin: FIXTURE,
      debounceMs: 50,
      interruptDebounceMs: 100,
      autoSteerEnabled: () => false,
      daemonOptsFor: () => ({ cwd: "/tmp", env: { FAKE_CLAUDE_MODE: "hang-no-result" } }),
      inFlightTimeoutMs: 60_000,
      onText: (_t, s) => texts.push(s),
    });
    reg.enqueue("topic-42", "start");
    await waitFor(() => texts.length >= 1, 5000);
    reg.enqueue("topic-42", "should NOT interrupt");
    await new Promise((r) => setTimeout(r, 400));        // > interruptDebounceMs
    expect(reg.getStatus("topic-42")).toBe("inFlight");  // still hung, no interrupt
    expect(texts.some((t) => t.includes("should NOT interrupt"))).toBe(false);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
