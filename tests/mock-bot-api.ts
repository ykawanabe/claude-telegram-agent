#!/usr/bin/env bun
/**
 * mock-bot-api.ts — Telegram Bot API stand-in for E2E tests.
 *
 * Intercepts Bot API methods and records the calls to a JSONL file. Tests
 * poll the file (or the test-side GET /__test__/captured endpoint) to
 * assert that the bot sent the expected messages — closing the loop
 * without involving real Telegram servers.
 *
 * Why a separate process: the topic-wrapper.sh → claude → mcp-telegram
 * chain spans multiple processes, all of which respect TELEGRAM_API_BASE.
 * A shared HTTP endpoint lets every layer record into one log file.
 *
 * Usage:
 *   bun run tests/mock-bot-api.ts <port> <record_file>
 *
 * Bot API endpoints exposed:
 *   GET/POST /bot<token>/getMe                 → static identity
 *   POST     /bot<token>/sendMessage           → recorded, returns ok
 *   POST     /bot<token>/sendChatAction        → recorded, returns ok
 *   POST     /bot<token>/setMessageReaction    → recorded, returns ok
 *   POST     /bot<token>/answerCallbackQuery   → recorded, returns ok
 *   POST     /bot<token>/getChatMember         → recorded, returns "creator"
 *   POST     /bot<token>/getUpdates            → drains injected queue, advances offset
 *   (other)                                    → 404, recorded as unknown
 *
 * Test-side helpers (under /__test__/ — NOT real Bot API):
 *   POST /__test__/inject       — body: TG Update JSON. Queued for next getUpdates.
 *   GET  /__test__/captured?method=<name>
 *                              — JSONL of recorded calls matching method.
 *   POST /__test__/reset        — clear queue + capture file.
 *
 * These extensions follow the jehy/telegram-test-api pattern (mock + test
 * helpers in one process) so E2E scenarios can drive the full inbound→
 * claude→outbound loop.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? "0");
const recordFile = process.argv[3] ?? "/tmp/mock-bot-api.jsonl";
if (!port) {
  console.error("usage: bun run mock-bot-api.ts <port> <record_file>");
  process.exit(1);
}
// Truncate the record file at startup so tests start from a clean slate.
writeFileSync(recordFile, "");

function record(entry: Record<string, unknown>): void {
  appendFileSync(recordFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// In-process queue of pending updates. Test code POSTs to /__test__/inject
// to enqueue; the next getUpdates request drains them. Items are TG Update
// shapes (without update_id — we assign that on drain so the test doesn't
// have to manage the counter).
type TgUpdate = Record<string, unknown>;
const updateQueue: TgUpdate[] = [];
let nextUpdateId = 1000;

// Drain queue, return Update[] with assigned update_ids. getUpdates' `offset`
// parameter is honored only loosely — once we hand out an update_id we don't
// re-emit it. Real Telegram does the same.
function drainUpdates(offset: number | undefined): TgUpdate[] {
  if (updateQueue.length === 0) return [];
  const taken = updateQueue.splice(0, updateQueue.length);
  return taken.map((u) => ({ update_id: nextUpdateId++, ...u }));
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // ─── Test-side helpers (under /__test__/) ─────────────────────────────
    if (url.pathname.startsWith("/__test__/")) {
      const op = url.pathname.replace("/__test__/", "");
      if (op === "inject" && req.method === "POST") {
        const body = (await req.json()) as TgUpdate;
        updateQueue.push(body);
        record({ method: "__inject", body });
        return Response.json({ ok: true, queued: updateQueue.length });
      }
      if (op === "captured" && req.method === "GET") {
        // Filter the on-disk record by `method` query param. JSONL → JSON
        // array for convenience. Errors-tolerant: malformed lines skipped.
        const wanted = url.searchParams.get("method");
        try {
          const file = Bun.file(recordFile);
          const text = await file.text();
          const lines = text.split("\n").filter((l) => l.length > 0);
          const items = lines.flatMap((l) => {
            try {
              const obj = JSON.parse(l) as Record<string, unknown>;
              if (wanted && obj.method !== wanted) return [];
              return [obj];
            } catch {
              return [];
            }
          });
          return Response.json({ ok: true, count: items.length, items });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }
      if (op === "reset" && req.method === "POST") {
        updateQueue.length = 0;
        writeFileSync(recordFile, "");
        nextUpdateId = 1000;
        return Response.json({ ok: true });
      }
      return Response.json(
        { ok: false, description: `mock: unknown test op /__test__/${op}` },
        { status: 404 },
      );
    }

    // ─── Bot API impersonation (paths /bot<TOKEN>/<method>) ────────────────
    const m = url.pathname.match(/^\/bot[^/]+\/(.+)$/);
    const method = m?.[1] ?? "(no-method)";
    let body: unknown = null;
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      try {
        if (ct.includes("application/json")) {
          body = await req.json();
        } else if (ct.includes("application/x-www-form-urlencoded")) {
          const text = await req.text();
          body = Object.fromEntries(new URLSearchParams(text));
        } else if (ct.includes("multipart/form-data")) {
          const form = await req.formData();
          body = Object.fromEntries(form);
        } else {
          body = await req.text();
        }
      } catch (e) {
        body = `<unparseable: ${e instanceof Error ? e.message : String(e)}>`;
      }
    } else {
      body = Object.fromEntries(url.searchParams);
    }
    record({ method, body });

    switch (method) {
      case "getMe":
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "MockBot", username: "mockbot", can_read_all_group_messages: true },
        });
      case "sendMessage":
        return Response.json({
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 1e6),
            chat: { id: (body as { chat_id?: number })?.chat_id ?? -1 },
            date: Math.floor(Date.now() / 1000),
            text: (body as { text?: string })?.text ?? "",
          },
        });
      case "sendChatAction":
      case "setMessageReaction":
      case "answerCallbackQuery":
      case "setMyCommands":
        // No interesting return shape; the poller checks for `ok` only.
        return Response.json({ ok: true, result: true });
      case "getChatMember": {
        // The poller calls this to verify the paired user is in the chat.
        // Return "creator" so any from_id passes the membership check.
        const userId = (body as { user_id?: number })?.user_id ?? 0;
        return Response.json({
          ok: true,
          result: {
            status: "creator",
            user: { id: userId, is_bot: false, first_name: "Test", username: "tester" },
          },
        });
      }
      case "getUpdates": {
        const offset = Number((body as { offset?: number })?.offset ?? 0) || undefined;
        let result = drainUpdates(offset);
        if (result.length === 0) {
          // Behave like a bounded Telegram long poll instead of returning an
          // empty result immediately. Immediate empties make the poller and
          // mock spin at thousands of requests/sec, obscuring real CPU/perf
          // regressions and producing huge capture files. Cap at 250ms so the
          // E2E suite stays fast, then drain again to pick up an update that
          // arrived while this request was waiting.
          const timeoutSec = Number((body as { timeout?: number })?.timeout ?? 0);
          const waitMs = Math.min(Math.max(timeoutSec * 1000, 25), 250);
          await Bun.sleep(waitMs);
          result = drainUpdates(offset);
        }
        return Response.json({ ok: true, result });
      }
      default:
        return Response.json({ ok: false, description: `mock: unhandled method ${method}` }, { status: 404 });
    }
  },
});

console.log(`mock-bot-api listening on :${port}, recording to ${recordFile}`);
