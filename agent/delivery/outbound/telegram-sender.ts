import type { ChatAddress, MessageRef, OutboundMessage } from "../../channels/types";
import { OutboundSendError, type OutboundSender } from "./types";

interface TelegramApiResponse {
  ok?: boolean;
  result?: { message_id?: number };
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramOutboundSenderOptions {
  token?: string;
  apiBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function telegramTarget(address: ChatAddress): Extract<ChatAddress, { channel: "telegram" }> {
  if (address.channel !== "telegram") {
    throw new OutboundSendError({
      kind: "permanent",
      message: `Telegram sender cannot deliver to ${address.channel}`,
    });
  }
  return address;
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function apiRetryAfterMs(json: TelegramApiResponse | null): number | undefined {
  const seconds = json?.parameters?.retry_after;
  return Number.isFinite(seconds) && (seconds ?? -1) >= 0
    ? Math.ceil((seconds as number) * 1000)
    : undefined;
}

function truncateUtf8(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= 64) return value;
  let trimmed = "";
  for (const char of value) {
    if (encoder.encode(trimmed + char).byteLength > 64) break;
    trimmed += char;
  }
  return trimmed;
}

function callbackData(threadId: number | undefined, label: string): string {
  // Telegram caps callback_data at 64 bytes, not JS code units.
  const prefix = `ans:${threadId ?? "dm"}:`;
  return truncateUtf8(prefix + label);
}

/**
 * A strict Telegram sendMessage client for the durable outbox. Unlike the
 * legacy best-effort adapter it never swallows failure and always returns the
 * real Telegram message_id.
 */
export class TelegramOutboundSender implements OutboundSender {
  private readonly token?: string;
  private readonly apiBase?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramOutboundSenderOptions = {}) {
    this.token = options.token;
    this.apiBase = options.apiBase;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(message: OutboundMessage): Promise<MessageRef> {
    const to = telegramTarget(message.to);
    const body: Record<string, unknown> = {
      chat_id: to.chatId,
      text: message.text,
    };
    if (to.threadId != null) body.message_thread_id = to.threadId;
    if (message.kind === "buttons") {
      body.reply_markup = {
        inline_keyboard: message.buttons.map((button) => {
          const label = typeof button === "string" ? button : button.label;
          const action = typeof button === "string"
            ? callbackData(to.threadId, label)
            : truncateUtf8(button.action);
          return [{ text: label, callback_data: action }];
        }),
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause instanceof OutboundSendError) throw cause;
      // Once fetch has begun, a timeout/reset cannot prove whether Telegram
      // committed the message. Automatic retry could duplicate user output.
      throw new OutboundSendError({
        kind: "uncertain",
        message: `Telegram send result is unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    } finally {
      clearTimeout(timeout);
    }

    let json: TelegramApiResponse | null = null;
    try {
      json = await response.json() as TelegramApiResponse;
    } catch (cause) {
      if (response.status === 429 || response.status >= 500) {
        throw this.retryableResponseError(response, null);
      }
      // A 2xx with an unreadable body may already have created the message.
      if (response.ok) {
        throw new OutboundSendError({
          kind: "uncertain",
          message: "Telegram accepted the request but returned an unreadable result",
          httpStatus: response.status,
          cause,
        });
      }
      throw new OutboundSendError({
        kind: "permanent",
        message: `Telegram HTTP ${response.status} with an unreadable error response`,
        httpStatus: response.status,
        cause,
      });
    }

    const errorCode = json.error_code;
    if (response.status === 429 || errorCode === 429 || response.status >= 500 || (errorCode ?? 0) >= 500) {
      throw this.retryableResponseError(response, json);
    }
    if (!response.ok || json.ok !== true) {
      throw new OutboundSendError({
        kind: "permanent",
        message: json.description ?? `Telegram rejected sendMessage (HTTP ${response.status})`,
        httpStatus: response.status,
        telegramErrorCode: errorCode,
      });
    }

    const messageId = json.result?.message_id;
    if (!Number.isSafeInteger(messageId) || (messageId ?? 0) <= 0) {
      throw new OutboundSendError({
        kind: "uncertain",
        message: "Telegram reported success without a valid message_id",
        httpStatus: response.status,
        telegramErrorCode: errorCode,
      });
    }
    return { channel: "telegram", chatId: to.chatId, messageId: messageId as number };
  }

  private baseUrl(): string {
    if (this.apiBase) return this.apiBase.replace(/\/$/, "");
    const token = this.token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new OutboundSendError({ kind: "permanent", message: "TELEGRAM_BOT_TOKEN must be set" });
    }
    return (process.env.TELEGRAM_API_BASE ?? `https://api.telegram.org/bot${token}`).replace(/\/$/, "");
  }

  private retryableResponseError(response: Response, json: TelegramApiResponse | null): OutboundSendError {
    const rateLimited = response.status === 429 || json?.error_code === 429;
    const headerDelay = parseRetryAfterHeader(response.headers.get("Retry-After"));
    const apiDelay = apiRetryAfterMs(json);
    return new OutboundSendError({
      kind: rateLimited ? "rate_limited" : "server_error",
      message: json?.description ?? `Telegram HTTP ${response.status}`,
      retryable: true,
      retryAfterMs: apiDelay ?? headerDelay,
      httpStatus: response.status,
      telegramErrorCode: json?.error_code,
    });
  }
}
