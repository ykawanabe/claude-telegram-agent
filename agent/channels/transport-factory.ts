/**
 * transport-factory — the DI seam that selects one ChatTransport per process.
 *
 * This is the ONLY module that imports a concrete platform adapter, which keeps
 * `types.ts` (the contract) platform-agnostic and means adding a platform is
 * "one more `case` + its adapter", with zero edits to the core. The poller calls
 * `makeTransport(CTA_CHANNEL ?? "telegram")` once at startup (replacing the old
 * hardcoded `new TelegramTransport()`).
 *
 * Phase 0 wires Telegram only — Telegram stays the hardcoded default until the
 * Slack adapter lands (Phase 3 uncomments the `case "slack"`).
 */
import {
  isButtonCapable,
  type ChatTransport,
  type Channel,
  type OutboundMessage,
  type OutboundQueue,
  type OutboundQueueResult,
} from "./types";
import { TelegramTransport } from "./telegram/transport";
import { join } from "node:path";
import { stateDir } from "../lib/paths";
import {
  FileOutboxStore,
  PersistentOutbox,
  outboxModeFromEnv,
  type OutboundSender,
  type OutboxEventSink,
  type OutboxMode,
} from "../delivery/outbound";
// Phase 3: import { SlackTransport } from "./slack/transport";

export function makeTransport(channel: Channel = "telegram"): ChatTransport {
  switch (channel) {
    case "telegram":
      return new TelegramTransport();
    // case "slack": return new SlackTransport();   // Phase 3
    default:
      throw new Error(`CTA_CHANNEL unsupported: ${channel}`);
  }
}

export interface OutboundQueueOptions {
  rootDir?: string;
  mode?: OutboxMode;
  events?: OutboxEventSink;
}

/**
 * Durable outbound adapter. Shadow mode is the default: it still persists and
 * makes exactly one real attempt, but only records what enforced retry policy
 * would have done. Enforced mode also drains due 429/5xx retries.
 */
export function makeOutboundQueue(
  transport: ChatTransport,
  options: OutboundQueueOptions = {},
): OutboundQueue {
  const mode = options.mode ?? outboxModeFromEnv();
  const sender: OutboundSender = {
    async send(message) {
      if (message.kind === "buttons" && isButtonCapable(transport)) {
        return transport.sendButtons({
          to: message.to,
          text: message.text,
          buttons: message.buttons,
        });
      }
      return transport.sendText({ to: message.to, text: message.text });
    },
  };
  const outbox = new PersistentOutbox({
    store: new FileOutboxStore(options.rootDir ?? join(stateDir(), "delivery", "outbound")),
    sender,
    mode,
    events: options.events,
  });
  outbox.start();

  const enqueueOne = async (
    message: OutboundMessage,
    deliveryKey = message.deliveryKey,
  ): Promise<OutboundQueueResult> => {
    try {
      const result = await outbox.enqueue(message, deliveryKey ? { deduplicationKey: deliveryKey } : {});
      return { status: result.status, messageRef: result.messageRef };
    } catch (error) {
      if (mode === "enforced") throw error;
      // Observational rollout must not turn journal ENOSPC/permission failures
      // into a new user-visible outage. Preserve the old one-attempt behavior.
      try {
        const messageRef = await sender.send(message);
        return { status: "delivered", messageRef };
      } catch (sendError) {
        process.stderr.write(
          `outbox shadow fallback failed: ${sendError instanceof Error ? sendError.message : String(sendError)}\n`,
        );
        return { status: "uncertain" };
      }
    }
  };

  const enqueueTracked = async (message: OutboundMessage): Promise<OutboundQueueResult> => {
    if (message.kind !== "text" || message.text.length <= transport.capabilities.text.maxChars) {
      return enqueueOne(message);
    }
    let result: OutboundQueueResult = { status: "queued" };
    const chunks = chunkText(message.text, transport.capabilities.text.maxChars);
    for (let index = 0; index < chunks.length; index += 1) {
      result = await enqueueOne(
        { ...message, text: chunks[index] },
        message.deliveryKey ? `${message.deliveryKey}:chunk:${index}` : undefined,
      );
    }
    return result;
  };

  return {
    async enqueue(message): Promise<void> {
      await enqueueTracked(message);
    },
    enqueueTracked,
    depth(): number {
      return outbox.depth();
    },
    stop(): Promise<void> {
      return outbox.stop();
    },
  };
}

function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
