import { test, expect, describe } from "bun:test";
import {
  buildClaudeArgv, buildGateEnv, makeStreamHandler, runAgentic, isSessionUnusableError,
  type AgenticSpawnLike,
} from "./agentic-runner";

describe("buildClaudeArgv", () => {
  const argv = buildClaudeArgv({
    task: "clean up the warnings", sessionUuid: "u1", resumeExisting: false,
    settingsPath: "/s.json", mcpConfigPath: "/m.json", model: "sonnet",
  });
  test("print + stream-json output + verbose", () => {
    expect(argv).toContain("-p");
    expect(argv.join(" ")).toContain("--output-format stream-json");
    expect(argv).toContain("--verbose");
  });
  test("gate is the boundary (skip-permissions) + settings wires the hook", () => {
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv[argv.indexOf("--settings") + 1]).toBe("/s.json");
  });
  test("does NOT use --input-format stream-json (task is positional)", () => {
    expect(argv).not.toContain("--input-format");
  });
  test("first run uses --session-id; resume uses --resume", () => {
    expect(argv).toContain("--session-id");
    expect(argv).not.toContain("--resume");
    const r = buildClaudeArgv({ task: "t", sessionUuid: "u1", resumeExisting: true, settingsPath: "/s.json" });
    expect(r).toContain("--resume");
    expect(r).not.toContain("--session-id");
  });
  test("task is the LAST argv element (positional prompt)", () => {
    expect(argv[argv.length - 1]).toBe("clean up the warnings");
  });
  test("mcp-config + model passed through", () => {
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/m.json");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  });
});

describe("buildGateEnv", () => {
  test("sets all AGENTIC_* the hook reads", () => {
    const env = buildGateEnv({ approvalsDir: "/a", mountPath: "/m", threadId: "260", chatId: 7, expiryMs: 1000, logFile: "/l" });
    expect(env).toEqual({
      AGENTIC_APPROVALS_DIR: "/a", AGENTIC_MOUNT: "/m", AGENTIC_THREAD_ID: "260",
      AGENTIC_CHAT_ID: "7", AGENTIC_EXPIRY_MS: "1000", AGENTIC_LOG_FILE: "/l",
    });
  });
  test("omits log file when absent", () => {
    const env = buildGateEnv({ approvalsDir: "/a", mountPath: "/m", threadId: "dm", chatId: 1, expiryMs: 5 });
    expect("AGENTIC_LOG_FILE" in env).toBe(false);
  });
});

describe("makeStreamHandler", () => {
  test("accumulates assistant text + cost, fires onText, tolerates split lines", () => {
    const seen: string[] = [];
    const h = makeStreamHandler((t) => seen.push(t));
    h.push('{"type":"assistant","message":{"content":[{"type":"text","text":"step 1"}]}}\n');
    h.push('{"type":"assist'); // split mid-line
    h.push('ant","message":{"content":[{"type":"text","text":"step 2"}]}}\n');
    h.push('{"type":"result","total_cost_usd":0.0123}\n');
    const acc = h.flush();
    expect(seen).toEqual(["step 1", "step 2"]);
    expect(acc.finalText).toBe("step 2");
    expect(acc.totalCostUsd).toBeCloseTo(0.0123, 4);
  });
  test("ignores non-JSON noise lines", () => {
    const h = makeStreamHandler();
    h.push("not json\n");
    h.push('{"type":"result","total_cost_usd":1}\n');
    expect(h.flush().totalCostUsd).toBe(1);
  });
});

// Fake spawn that streams canned stream-json then exits with the given code.
function fakeSpawn(lines: string[], exitCode = 0): AgenticSpawnLike {
  return () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const l of lines) c.enqueue(enc.encode(l + "\n"));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: Promise.resolve(exitCode),
    kill() {}, killed: false,
  });
}

describe("runAgentic (fake spawn)", () => {
  const base = {
    mountPath: "/m", threadId: "dm", chatId: 1, task: "do x",
    approvalsDir: "/a", settingsPath: "/s.json", sessionUuid: "u", resumeExisting: false,
  };
  test("streams text and returns done with cost", async () => {
    const seen: string[] = [];
    const r = await runAgentic({
      ...base,
      onText: (t) => seen.push(t),
      spawn: fakeSpawn([
        '{"type":"assistant","message":{"content":[{"type":"text","text":"working…"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"done, summary here"}]}}',
        '{"type":"result","total_cost_usd":0.05}',
      ]),
    });
    expect(r.status).toBe("done");
    expect(r.finalText).toBe("done, summary here");
    expect(r.totalCostUsd).toBeCloseTo(0.05, 4);
    expect(seen).toContain("working…");
  });
  test("non-zero exit → error", async () => {
    const r = await runAgentic({ ...base, spawn: fakeSpawn(["noise"], 2) });
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("exited 2");
  });
  test("surfaces the result-event reason when stderr is empty (model unavailable)", async () => {
    // claude reports model-unavailable in the result event, not stderr — exit 1
    // with blank stderr. The message must carry the real reason, not be empty.
    const r = await runAgentic({
      ...base,
      spawn: fakeSpawn([
        '{"type":"system","subtype":"init"}',
        '{"type":"result","subtype":"success","is_error":true,"result":"Claude Fable 5 is currently unavailable."}',
      ], 1),
    });
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("exited 1");
    expect(r.errorMessage).toContain("Claude Fable 5 is currently unavailable");
  });
});

describe("isSessionUnusableError", () => {
  test("matches a dead conversation and an unavailable pinned model", () => {
    expect(isSessionUnusableError("claude exited 1: No conversation found for session abc")).toBe(true);
    expect(isSessionUnusableError("claude exited 1: Claude Fable 5 is currently unavailable.")).toBe(true);
    expect(isSessionUnusableError("claude exited 1: model claude-fable-5 not found")).toBe(true);
  });
  test("does NOT match ordinary task failures (those should surface, not self-heal)", () => {
    expect(isSessionUnusableError("claude exited 1: TypeError: cannot read x")).toBe(false);
    expect(isSessionUnusableError(undefined)).toBe(false);
    expect(isSessionUnusableError("")).toBe(false);
  });
});
