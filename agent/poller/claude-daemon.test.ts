/**
 * Tests for ClaudeDaemon — the long-lived per-topic claude subprocess that
 * replaces the per-message `claude -p` of Phase 2 (claude-runner.ts).
 *
 * Strategy: use fixtures/fake-claude-daemon.sh as the subprocess. It mimics
 * `claude -p --input-format stream-json --output-format stream-json --verbose`
 * — reads JSON user events on stdin, emits assistant + result events on
 * stdout, stays alive between turns. Lets us assert real I/O wiring
 * without spawning the real (expensive, network-bound) claude.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeDaemon } from "./claude-daemon";
import type { TurnEndInfo } from "./claude-daemon";

const FIXTURE = join(import.meta.dir, "fixtures/fake-claude-daemon.sh");

describe("ClaudeDaemon basic lifecycle", () => {
  let daemon: ClaudeDaemon | null = null;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = null; } });

  test("start spawns the subprocess and reports alive", async () => {
    daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    await daemon.start();
    expect(daemon.isAlive).toBe(true);
  });

  test("stop terminates the subprocess; isAlive flips false", async () => {
    daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    await daemon.start();
    await daemon.stop();
    expect(daemon.isAlive).toBe(false);
  });

  test("send writes a JSON user event to stdin and emits assistant text", async () => {
    daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    const texts: string[] = [];
    daemon.on("text", (s: string) => texts.push(s));
    await daemon.start();
    await daemon.send("hello world");
    // Give fake claude a beat to respond.
    await waitFor(() => texts.length > 0, 5000);
    expect(texts[0]).toBe("You said: hello world");
  });

  test("multiple sends to same daemon get separate replies (process stays alive across turns)", async () => {
    daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    const texts: string[] = [];
    daemon.on("text", (s: string) => texts.push(s));
    await daemon.start();

    await daemon.send("first");
    await waitFor(() => texts.length >= 1, 5000);
    await daemon.send("second");
    await waitFor(() => texts.length >= 2, 5000);

    expect(texts).toContain("You said: first");
    expect(texts).toContain("You said: second");
    expect(daemon.isAlive).toBe(true); // still alive after 2 turns
  });

  test("turn-end event carries cost + sessionId from the result event", async () => {
    daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    const turns: Array<{ costUsd: number | null; sessionId: string | null }> = [];
    daemon.on("turn-end", (info) => turns.push(info));
    await daemon.start();
    await daemon.send("ping");
    await waitFor(() => turns.length > 0, 5000);
    expect(turns[0].costUsd).toBeCloseTo(0.0042, 4);
    expect(turns[0].sessionId).toBe("fake-session-uuid");
  });
});

describe("ClaudeDaemon streaming output (multi-block turn)", () => {
  let daemon: ClaudeDaemon | null = null;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = null; } });

  test("multi-block turn fires 'text' once per block (multi-message UX)", async () => {
    daemon = new ClaudeDaemon({
      claudeBin: FIXTURE,
      cwd: "/tmp",
      env: { FAKE_CLAUDE_MODE: "multiblock" },
    });
    const texts: string[] = [];
    daemon.on("text", (s: string) => texts.push(s));
    await daemon.start();
    await daemon.send("hi");
    await waitFor(() => texts.length >= 2, 5000);
    expect(texts[0]).toBe("thinking…");
    expect(texts[1]).toBe("answer: hi");
  });

  test("does not expose an unterminated stdout tail until a newline arrives", () => {
    const daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    const texts: string[] = [];
    daemon.on("text", (s: string) => texts.push(s));
    const feedStdout = daemon as unknown as { onStdout(chunk: string): void };

    feedStdout.onStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"tail"}]}}');
    expect(texts).toEqual([]);

    feedStdout.onStdout("\n");
    expect(texts).toEqual(["tail"]);
  });
});

describe("ClaudeDaemon crash recovery", () => {
  let daemon: ClaudeDaemon | null = null;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = null; } });

  test("subprocess crash fires 'crash' event with exit code", async () => {
    daemon = new ClaudeDaemon({
      claudeBin: FIXTURE,
      cwd: "/tmp",
      env: { FAKE_CLAUDE_MODE: "crash-on-turn-2" },
    });
    const crashes: Array<{ code: number | null }> = [];
    daemon.on("crash", (info) => crashes.push(info));
    await daemon.start();

    // Turn 1 ok, turn 2 triggers exit 1.
    await daemon.send("turn 1");
    await new Promise((r) => setTimeout(r, 200));
    await daemon.send("turn 2");
    await waitFor(() => crashes.length > 0, 3000);

    expect(crashes[0].code).toBe(1);
    expect(daemon.isAlive).toBe(false);
  });

  test("send on a stopped daemon throws (caller should respawn first)", async () => {
    daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    await daemon.start();
    await daemon.stop();
    await expect(daemon.send("after death")).rejects.toThrow();
  });
});

describe("ClaudeDaemon argv composition", () => {
  test("buildArgv includes --input-format + --output-format stream-json", () => {
    const argv = ClaudeDaemon.buildArgv({
      sessionUuid: "uuid-xyz",
      resumeExisting: false,
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("--input-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--session-id");
    expect(argv).toContain("uuid-xyz");
  });

  test("buildArgv uses --resume when JSONL exists", () => {
    const argv = ClaudeDaemon.buildArgv({
      sessionUuid: "uuid-xyz",
      resumeExisting: true,
    });
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--session-id");
  });

  test("buildArgv adds --mcp-config without --strict-mcp-config (merges user's ~/.claude.json MCPs)", () => {
    const argv = ClaudeDaemon.buildArgv({
      sessionUuid: "u",
      resumeExisting: false,
      mcpConfigPath: "/tmp/cfg.json",
    });
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/tmp/cfg.json");
    // Regression guard: --strict-mcp-config must NOT be present. We
    // intentionally merge the per-topic telegram MCP with the user's own
    // MCPs (Notion, browser, gmail, etc.) so the secretary daemon has the
    // same authority as `claude` invoked from the user's CLI.
    expect(argv).not.toContain("--strict-mcp-config");
  });

  test("buildArgv adds --append-system-prompt when provided", () => {
    const argv = ClaudeDaemon.buildArgv({
      sessionUuid: "u",
      resumeExisting: false,
      appendSystemPrompt: "be terse",
    });
    expect(argv).toContain("--append-system-prompt");
    expect(argv).toContain("be terse");
  });
});

describe("ClaudeDaemon interrupt", () => {
  test("interrupt() ends the in-flight turn without killing the process", async () => {
    const turnEnds: TurnEndInfo[] = [];
    const daemon = new ClaudeDaemon({
      claudeBin: FIXTURE,
      cwd: "/tmp",
      env: { FAKE_CLAUDE_MODE: "hang-no-result" },
    });
    daemon.on("turn-end", (i) => turnEnds.push(i));
    await daemon.start();
    await daemon.send("long task");
    // hang-no-result posts text but never a result → no turn-end yet.
    await new Promise((r) => setTimeout(r, 300));
    expect(turnEnds.length).toBe(0);

    await daemon.interrupt();
    // The fixture replies with a result → turn-end fires, process stays alive.
    await waitFor(() => turnEnds.length === 1, 5000);
    expect(daemon.isAlive).toBe(true);   // isAlive is a GETTER, not a method

    // Same warm process answers the next message.
    const texts: string[] = [];
    daemon.on("text", (t) => texts.push(t));
    await daemon.send("after interrupt");
    await waitFor(() => texts.some((t) => t.includes("after interrupt")), 5000);

    await daemon.stop("SIGKILL");
  });

  test("interrupt() throws when the daemon is not running", async () => {
    const daemon = new ClaudeDaemon({ claudeBin: FIXTURE, cwd: "/tmp" });
    await expect(daemon.interrupt()).rejects.toThrow();
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
