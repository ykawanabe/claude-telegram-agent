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
  type OutboundQueue,
} from "./types";
import { TelegramTransport } from "./telegram/transport";
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

/**
 * Phase 0 OutboundQueue adapter. This preserves today's best-effort delivery:
 * messages are sent immediately and are not persisted or retried here.
 */
export function makeOutboundQueue(transport: ChatTransport): OutboundQueue {
  return {
    async enqueue(message): Promise<void> {
      switch (message.kind) {
        case "text":
          await transport.sendText({ to: message.to, text: message.text });
          return;
        case "buttons":
          if (isButtonCapable(transport)) {
            await transport.sendButtons({
              to: message.to,
              text: message.text,
              buttons: message.buttons,
            });
          } else {
            await transport.sendText({ to: message.to, text: message.text });
          }
          return;
      }
    },
  };
}
