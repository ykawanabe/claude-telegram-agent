import { describe, expect, test } from "bun:test";
import { TelegramOutboundSender } from "./telegram-sender";
import { OutboundSendError } from "./types";

const textMessage = {
  kind: "text" as const,
  to: { channel: "telegram" as const, chatId: -100, threadId: 42 },
  text: "hello",
};

function senderWith(response: Response | (() => Promise<Response>)): TelegramOutboundSender {
  const fetchImpl = async () => typeof response === "function" ? response() : response.clone();
  return new TelegramOutboundSender({ apiBase: "http://telegram.test/botfake", fetch: fetchImpl as typeof fetch });
}

describe("TelegramOutboundSender", () => {
  test("returns the real message_id and sends the topic", async () => {
    let body: Record<string, unknown> | undefined;
    const sender = new TelegramOutboundSender({
      apiBase: "http://telegram.test/botfake",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ok: true, result: { message_id: 2468 } });
      }) as typeof fetch,
    });

    const ref = await sender.send(textMessage);

    expect(ref).toEqual({ channel: "telegram", chatId: -100, messageId: 2468 });
    expect(body).toMatchObject({ chat_id: -100, message_thread_id: 42, text: "hello" });
  });

  test("builds inline buttons and truncates callback_data by UTF-8 bytes", async () => {
    let body: Record<string, unknown> | undefined;
    const sender = new TelegramOutboundSender({
      apiBase: "http://telegram.test/botfake",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ok: true, result: { message_id: 9 } });
      }) as typeof fetch,
    });
    await sender.send({
      kind: "buttons",
      to: { channel: "telegram", chatId: 1, threadId: 7 },
      text: "pick",
      buttons: ["あ".repeat(100), { label: "Approve", action: "apv:req-1:allow" }],
    });

    const markup = body?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(new TextEncoder().encode(markup.inline_keyboard[0][0].callback_data).byteLength).toBeLessThanOrEqual(64);
    expect(markup.inline_keyboard[0][0].callback_data.startsWith("ans:7:")).toBe(true);
    expect(markup.inline_keyboard[1][0].callback_data).toBe("apv:req-1:allow");
  });

  test("classifies Telegram 429 and honours body retry_after", async () => {
    const sender = senderWith(Response.json(
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 13 } },
      { status: 429, headers: { "Retry-After": "2" } },
    ));

    try {
      await sender.send(textMessage);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OutboundSendError);
      expect(error).toMatchObject({ kind: "rate_limited", retryable: true, retryAfterMs: 13_000, httpStatus: 429 });
    }
  });

  test("uses Retry-After header when Telegram parameters are absent", async () => {
    const sender = senderWith(Response.json(
      { ok: false, error_code: 429, description: "slow down" },
      { status: 429, headers: { "Retry-After": "4" } },
    ));
    await expect(sender.send(textMessage)).rejects.toMatchObject({ retryAfterMs: 4_000 });
  });

  test("classifies HTTP/API 5xx as retryable", async () => {
    const http = senderWith(Response.json({ ok: false, description: "bad gateway" }, { status: 502 }));
    await expect(http.send(textMessage)).rejects.toMatchObject({
      kind: "server_error",
      retryable: true,
      httpStatus: 502,
    });

    const api = senderWith(Response.json({ ok: false, error_code: 503, description: "unavailable" }, { status: 200 }));
    await expect(api.send(textMessage)).rejects.toMatchObject({
      kind: "server_error",
      retryable: true,
      telegramErrorCode: 503,
    });
  });

  test("classifies non-rate-limit 4xx as permanent", async () => {
    const sender = senderWith(Response.json(
      { ok: false, error_code: 400, description: "Bad Request: chat not found" },
      { status: 400 },
    ));
    await expect(sender.send(textMessage)).rejects.toMatchObject({
      kind: "permanent",
      retryable: false,
      telegramErrorCode: 400,
    });
  });

  test("classifies network/timeout and missing success message_id as uncertain", async () => {
    const network = new TelegramOutboundSender({
      apiBase: "http://telegram.test/botfake",
      fetch: (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch,
    });
    await expect(network.send(textMessage)).rejects.toMatchObject({ kind: "uncertain", retryable: false });

    const missing = senderWith(Response.json({ ok: true, result: {} }));
    await expect(missing.send(textMessage)).rejects.toMatchObject({ kind: "uncertain", retryable: false });
  });

  test("keeps missing credentials permanent instead of rewrapping them as uncertain", async () => {
    let fetched = false;
    const sender = new TelegramOutboundSender({
      token: "",
      fetch: (async () => {
        fetched = true;
        return Response.json({ ok: true, result: { message_id: 1 } });
      }) as typeof fetch,
    });

    await expect(sender.send(textMessage)).rejects.toMatchObject({ kind: "permanent", retryable: false });
    expect(fetched).toBe(false);
  });
});
