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
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

function positiveSafeInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a positive safe integer no greater than ${max}`);
  }
  return value;
}

function secondsToMilliseconds(seconds: unknown): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.ceil(seconds * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
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
  const secondsDelay = secondsToMilliseconds(Number(value));
  if (secondsDelay != null) return secondsDelay;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function apiRetryAfterMs(json: TelegramApiResponse | null): number | undefined {
  return secondsToMilliseconds(json?.parameters?.retry_after);
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason ?? new Error("Telegram response read aborted");
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Telegram response read aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function readTelegramResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<TelegramApiResponse> {
  if (!response.body) throw new Error("Telegram returned an empty response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Telegram response exceeds maxResponseBytes (${total} > ${maxBytes})`);
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Telegram returned a non-object JSON response");
  }
  return parsed as TelegramApiResponse;
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
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramOutboundSenderOptions = {}) {
    this.token = options.token;
    this.apiBase = options.apiBase;
    this.timeoutMs = positiveSafeInteger(
      options.timeoutMs ?? 15_000,
      "Telegram timeoutMs",
      MAX_TIMER_MS,
    );
    this.maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "Telegram maxResponseBytes",
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(message: OutboundMessage, signal?: AbortSignal): Promise<MessageRef> {
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
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(`Telegram send timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let json: TelegramApiResponse | null = null;
      try {
        json = await readTelegramResponse(response, this.maxResponseBytes, controller.signal);
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
    } catch (cause) {
      if (cause instanceof OutboundSendError) throw cause;
      // Once fetch has begun, a timeout/reset/cancel cannot prove whether
      // Telegram committed the message. Automatic retry could duplicate it.
      throw new OutboundSendError({
        kind: "uncertain",
        message: `Telegram send result is unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
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
