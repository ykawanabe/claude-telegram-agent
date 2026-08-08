import type { InboundEvent } from "../channels/types";

/** A normalized inbound message, used by bot features unless they opt in to a
 * more specific event type. */
export type MessageInboundEvent<Raw = unknown> = Extract<
  InboundEvent<Raw>,
  { kind: "message" }
>;

/** The command token and the exact, untrimmed text following its first space. */
export interface ParsedBotCommand {
  readonly command: string;
  readonly args: string;
}

/** Everything a feature needs to decide whether it consumes a command. */
export interface BotFeatureContext<Event = MessageInboundEvent>
  extends ParsedBotCommand {
  readonly event: Event;
}

/**
 * A platform-neutral unit of bot command behavior.
 *
 * Returning true consumes the message and suppresses daemon dispatch. Returning
 * false lets the command fall through to the daemon or the next routing stage.
 */
export interface BotFeature<Event = MessageInboundEvent> {
  readonly id: string;
  readonly commands: readonly string[];
  tryHandle(context: BotFeatureContext<Event>): Promise<boolean>;
}

/**
 * Parse a bot command using the poller's existing wire semantics.
 *
 * Only a literal ASCII space separates the command from its arguments. The
 * argument remainder is returned byte-for-byte (including extra spaces), while
 * the command has its bot username suffix removed and is lowercased.
 */
export function parseBotCommand(text: string): ParsedBotCommand | null {
  if (!text.startsWith("/")) return null;

  const firstSpace = text.indexOf(" ");
  const head = firstSpace < 0 ? text : text.slice(0, firstSpace);
  const command = head.split("@")[0].toLowerCase();
  const args = firstSpace < 0 ? "" : text.slice(firstSpace + 1);

  return { command, args };
}
