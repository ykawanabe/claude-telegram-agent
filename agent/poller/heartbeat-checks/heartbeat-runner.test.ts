/**
 * Tests for heartbeat-runner.
 *
 * Three layers:
 *  - parseStreamJson: pure, fed handcrafted claude stream-json strings.
 *  - buildClaudeArgv: pin the Design A invariants (--tools list, no Bash).
 *  - runHeartbeat: full end-to-end through the runner with injected
 *    readHeartbeatMd, dispatchCheck, and spawn seams. No real claude, no
 *    real `gh`, no real filesystem.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClaudeArgv,
  parseStreamJson,
  runHeartbeat,
  type ClaudeSpawnLike,
} from "./heartbeat-runner";
import type { CheckResult, HandlerContext } from "./registry";

// Helpers ─────────────────────────────────────────────────────────────────────

/** Build a stream-json blob from a list of assistant text snippets and a
 *  final result event's cost. Mirrors what real claude emits with
 *  --output-format stream-json --verbose. */
function fakeStreamJson(assistantSnippets: string[], totalCostUsd: number): string {
  const lines: string[] = [];
  for (const text of assistantSnippets) {
    lines.push(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }));
  }
  lines.push(JSON.stringify({
    type: "result",
    total_cost_usd: totalCostUsd,
  }));
  return lines.join("\n") + "\n";
}

/** Build a claude spawn fake that returns canned stdout/stderr/exit. */
function fakeClaude(stdout: string, stderr: string, exitCode: number, exitDelayMs = 0): ClaudeSpawnLike {
  return ((_opts) => ({
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: new Promise<number>((resolve) => {
      if (exitDelayMs <= 0) resolve(exitCode);
      else setTimeout(() => resolve(exitCode), exitDelayMs);
    }),
    kill: () => {},
    killed: false,
  })) as ClaudeSpawnLike;
}

function fakeClaudeCapturing(stdout: string, exitCode = 0) {
  const captured: { cmd?: string[]; cwd?: string } = {};
  const fn: ClaudeSpawnLike = ((opts) => {
    captured.cmd = opts.cmd;
    captured.cwd = opts.cwd;
    return {
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(exitCode),
      kill: () => {},
      killed: false,
    };
  }) as ClaudeSpawnLike;
  return { fn, captured };
}

function okCheck(items: unknown[] = []): CheckResult {
  return { status: items.length > 0 ? "ok" : "empty", items };
}

// parseStreamJson ─────────────────────────────────────────────────────────────

describe("parseStreamJson", () => {
  test("accumulates assistant text across multiple assistant events", () => {
    const stream = fakeStreamJson(["First chunk. ", "Second chunk."], 0.05);
    const r = parseStreamJson(stream);
    expect(r.assistantText).toBe("First chunk. Second chunk.");
    expect(r.totalCostUsd).toBe(0.05);
  });

  test("captures total_cost_usd from the final result event", () => {
    const r = parseStreamJson(fakeStreamJson(["x"], 0.0184));
    expect(r.totalCostUsd).toBe(0.0184);
  });

  test("tolerates non-JSON noise lines (claude startup occasionally emits them)", () => {
    const stream = "this is not json\n" + fakeStreamJson(["hello"], 0.01) + "more garbage\n";
    const r = parseStreamJson(stream);
    expect(r.assistantText).toBe("hello");
    expect(r.totalCostUsd).toBe(0.01);
  });

  test("missing result event → cost is 0, no throw", () => {
    const stream = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "only assistant" }] },
    }) + "\n";
    const r = parseStreamJson(stream);
    expect(r.assistantText).toBe("only assistant");
    expect(r.totalCostUsd).toBe(0);
  });

  test("empty stream → empty result", () => {
    const r = parseStreamJson("");
    expect(r.assistantText).toBe("");
    expect(r.totalCostUsd).toBe(0);
  });

  test("parses an unterminated EOF tail and concatenates text blocks in order", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "one " },
        { type: "thinking", text: "hidden" },
        { type: "text", text: "two" },
      ] },
    });
    const result = JSON.stringify({ type: "result", total_cost_usd: 0.2 });

    expect(parseStreamJson(`${assistant}\n${result}`)).toEqual({
      assistantText: "one two",
      totalCostUsd: 0.2,
    });
  });
});

// buildClaudeArgv — Design A invariants ──────────────────────────────────────

describe("buildClaudeArgv — Design A invariants", () => {
  const argv = buildClaudeArgv({
    prompt: "user prompt",
    sessionUuid: "session-xyz",
    model: "claude-sonnet-4-6",
    resumeExisting: true,
  });

  test("includes --tools Read,Glob,Grep (no Bash)", () => {
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("Read,Glob,Grep");
    // Triple-check the safety property: no Bash anywhere in the value.
    expect(argv[i + 1]).not.toContain("Bash");
    expect(argv[i + 1]).not.toContain("bash");
  });

  test("includes --output-format stream-json --verbose (cost capture requires both)", () => {
    const ofi = argv.indexOf("--output-format");
    expect(argv[ofi + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
  });

  test("includes --resume <sessionUuid> (day-over-day continuity)", () => {
    const i = argv.indexOf("--resume");
    expect(argv[i + 1]).toBe("session-xyz");
  });

  test("uses --session-id for first fire (claude creates the session)", () => {
    const fresh = buildClaudeArgv({
      prompt: "x", sessionUuid: "new-uuid", model: "m", resumeExisting: false,
    });
    expect(fresh).toContain("--session-id");
    expect(fresh).not.toContain("--resume");
    const i = fresh.indexOf("--session-id");
    expect(fresh[i + 1]).toBe("new-uuid");
  });

  test("includes the prompt as -p <positional>", () => {
    const i = argv.indexOf("-p");
    expect(argv[i + 1]).toBe("user prompt");
  });

  test("appends a system prompt that mentions NOTHING_TO_REPORT", () => {
    const i = argv.indexOf("--append-system-prompt");
    expect(argv[i + 1]).toContain("NOTHING_TO_REPORT");
  });

  test("includes --dangerously-skip-permissions (ok — tool list has nothing dangerous)", () => {
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  test("argv elements have no shell metacharacters in their structural positions", () => {
    // Skip the prompt (-p value) and system prompt — those CAN contain
    // anything because Bun.spawn passes argv straight to execvp(); the
    // values become literal argv[N] in the child's argv table, no shell
    // interpretation. We assert the FLAGS themselves are clean.
    const promptIdx = argv.indexOf("-p") + 1;
    const sysIdx = argv.indexOf("--append-system-prompt") + 1;
    for (let i = 0; i < argv.length; i++) {
      if (i === promptIdx || i === sysIdx) continue;
      expect(argv[i]).not.toMatch(/[;&|`$<>()]/);
    }
  });
});

// runHeartbeat ───────────────────────────────────────────────────────────────

describe("runHeartbeat — orchestration", () => {
  test("returns no-heartbeat-md when file is missing", async () => {
    const r = await runHeartbeat({
      mountPath: "/tmp/nonexistent",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => null, // simulate missing
      dispatchCheck: async () => okCheck(),
      spawn: fakeClaude("", "", 0),
    });
    expect(r.status).toBe("no-heartbeat-md");
    expect(r.digestText).toBeNull();
    expect(r.checksRan).toHaveLength(0);
    expect(r.errorMessage).toContain("not found");
  });

  test("returns no-heartbeat-md when file has no check IDs (only comments)", async () => {
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "# just comments\n# no checks here\n",
      dispatchCheck: async () => okCheck(),
      spawn: fakeClaude("", "", 0),
    });
    expect(r.status).toBe("no-heartbeat-md");
    expect(r.errorMessage).toContain("no check IDs");
  });

  test("dispatches each parsed check ID in parallel", async () => {
    const calls: string[] = [];
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\nci-red\nurgent-todos\n",
      dispatchCheck: async (id: string, _ctx: HandlerContext) => {
        calls.push(id);
        return okCheck();
      },
      spawn: fakeClaude(fakeStreamJson(["NOTHING_TO_REPORT"], 0.02), "", 0),
    });
    expect(calls.sort()).toEqual(["ci-red", "open-prs", "urgent-todos"]);
    expect(r.checksRan).toEqual(["open-prs", "ci-red", "urgent-todos"]); // preserves order
    expect(r.status).toBe("empty");
  });

  test("collects checksErrored list (status='error' or 'timeout')", async () => {
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\nci-red\nurgent-todos\n",
      dispatchCheck: async (id: string) => {
        if (id === "open-prs") return { status: "error", items: [], errorMessage: "gh missing" };
        if (id === "urgent-todos") return { status: "timeout", items: [], errorMessage: "10s" };
        return okCheck();
      },
      spawn: fakeClaude(fakeStreamJson(["digest"], 0.01), "", 0),
    });
    expect(r.checksErrored.sort()).toEqual(["open-prs", "urgent-todos"]);
  });

  test("NOTHING_TO_REPORT (entire trimmed turn) → status='empty', digestText null", async () => {
    const variants = [
      "NOTHING_TO_REPORT",
      " NOTHING_TO_REPORT ",
      "NOTHING_TO_REPORT.",
      "**NOTHING_TO_REPORT**",
      "nothing_to_report",
      "*NOTHING_TO_REPORT*",
    ];
    for (const text of variants) {
      const r = await runHeartbeat({
        mountPath: "/tmp/x",
        threadId: "dm",
        sessionUuid: "u1",
        readHeartbeatMd: async () => "open-prs\n",
        dispatchCheck: async () => okCheck(),
        spawn: fakeClaude(fakeStreamJson([text], 0.005), "", 0),
      });
      expect(r.status).toBe("empty");
      expect(r.digestText).toBeNull();
      expect(r.totalCostUsd).toBe(0.005);
    }
  });

  test("non-empty digest passes through verbatim (no markdown stripping)", async () => {
    const digest = "- PR #42 still waiting on review (3 days)\n- CI red on feature/foo since 2h ago";
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck([{ number: 42 }]),
      spawn: fakeClaude(fakeStreamJson([digest], 0.018), "", 0),
    });
    expect(r.status).toBe("sent");
    expect(r.digestText).toBe(digest);
    expect(r.totalCostUsd).toBe(0.018);
  });

  test("digest containing 'HEARTBEAT_OK was the rule' substring does NOT false-drop", async () => {
    const text = "I see NOTHING_TO_REPORT was the rule but I have one item: PR #5 stale.";
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck([{}]),
      spawn: fakeClaude(fakeStreamJson([text], 0.02), "", 0),
    });
    expect(r.status).toBe("sent");
    expect(r.digestText).toContain("PR #5 stale");
  });

  test("claude exit≠0 → status='error' with stderr excerpt", async () => {
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: fakeClaude("", "auth required\n", 1),
    });
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("exited 1");
    expect(r.errorMessage).toContain("auth required");
  });

  test("empty assistant text → status='error' (model should have said NOTHING_TO_REPORT)", async () => {
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: fakeClaude(fakeStreamJson([], 0.001), "", 0),
    });
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("empty assistant text");
  });

  test("SIGKILL escalation (claude doesn't exit) → status='timeout'", async () => {
    // Slow claude: doesn't resolve until aborted. SIGKILL at 30ms.
    const slowClaude: ClaudeSpawnLike = ((opts) => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: new Promise<number>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(137), { once: true });
      }),
      kill: () => {},
      killed: false,
    })) as ClaudeSpawnLike;
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      sigTermMs: 15,
      sigKillMs: 30,
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: slowClaude,
    });
    expect(r.status).toBe("timeout");
    expect(r.errorMessage).toContain("SIGKILL");
  });

  test("spawn receives cwd = mountPath (claude reads HEARTBEAT.md / files relative to the worktree)", async () => {
    const { fn, captured } = fakeClaudeCapturing(fakeStreamJson(["NOTHING_TO_REPORT"], 0.001));
    await runHeartbeat({
      mountPath: "/some/specific/mount",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: fn,
    });
    expect(captured.cwd).toBe("/some/specific/mount");
  });

  test("argv passed to spawn includes --tools 'Read,Glob,Grep' (live invariant pin, not just buildClaudeArgv)", async () => {
    const { fn, captured } = fakeClaudeCapturing(fakeStreamJson(["NOTHING_TO_REPORT"], 0.001));
    await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: fn,
    });
    expect(captured.cmd).toBeDefined();
    const i = captured.cmd!.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(captured.cmd![i + 1]).toBe("Read,Glob,Grep");
    // Argv[0] is the claude binary name. The runner passes opts.claudeBin
    // (default "claude") as the first element.
    expect(captured.cmd![0]).toBe("claude");
  });

  test("respects opts.claudeBin override (for tests / non-PATH installs)", async () => {
    const { fn, captured } = fakeClaudeCapturing(fakeStreamJson(["NOTHING_TO_REPORT"], 0.001));
    await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      claudeBin: "/opt/special/claude",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: fn,
    });
    expect(captured.cmd![0]).toBe("/opt/special/claude");
  });

  test("durationMs is captured (>= 0, < 60s for the fake path)", async () => {
    const r = await runHeartbeat({
      mountPath: "/tmp/x",
      threadId: "dm",
      sessionUuid: "u1",
      readHeartbeatMd: async () => "open-prs\n",
      dispatchCheck: async () => okCheck(),
      spawn: fakeClaude(fakeStreamJson(["NOTHING_TO_REPORT"], 0.001), "", 0),
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.durationMs).toBeLessThan(60_000);
  });
});
