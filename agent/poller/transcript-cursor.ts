/** A normalized, user-visible text block from a stream-json assistant event. */
export interface TranscriptAssistantEvent {
  readonly type: "assistant";
  readonly text: string;
}

/** The fields consumers use from a stream-json result event. */
export interface TranscriptResultEvent {
  readonly type: "result";
  readonly isError?: boolean;
  readonly result?: string;
  readonly costUsd?: number;
  readonly sessionId?: string;
}

export type TranscriptEvent = TranscriptAssistantEvent | TranscriptResultEvent;

/**
 * Incrementally frames and parses a newline-delimited stream-json transcript.
 * `push` only parses newline-terminated records; `finish` explicitly consumes
 * the final unterminated record at EOF.
 */
export interface TranscriptCursor {
  push(chunk: string): TranscriptEvent[];
  finish(): TranscriptEvent[];
  reset(): void;
}

/** Default pure NDJSON implementation of TranscriptCursor. */
export class NdjsonTranscriptCursor implements TranscriptCursor {
  private tail = "";

  push(chunk: string): TranscriptEvent[] {
    this.tail += chunk;
    const events: TranscriptEvent[] = [];

    let newline: number;
    while ((newline = this.tail.indexOf("\n")) >= 0) {
      events.push(...parseLine(this.tail.slice(0, newline)));
      this.tail = this.tail.slice(newline + 1);
    }

    return events;
  }

  finish(): TranscriptEvent[] {
    const finalLine = this.tail;
    this.tail = "";
    return parseLine(finalLine);
  }

  reset(): void {
    this.tail = "";
  }
}

export function createTranscriptCursor(): TranscriptCursor {
  return new NdjsonTranscriptCursor();
}

function parseLine(line: string): TranscriptEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!isRecord(value)) return [];

  if (value.type === "assistant") {
    if (!isRecord(value.message) || !Array.isArray(value.message.content)) return [];

    const events: TranscriptAssistantEvent[] = [];
    for (const block of value.message.content) {
      if (
        isRecord(block)
        && block.type === "text"
        && typeof block.text === "string"
        && block.text.length > 0
      ) {
        events.push({ type: "assistant", text: block.text });
      }
    }
    return events;
  }

  if (value.type === "result") {
    const event: TranscriptResultEvent = {
      type: "result",
      ...(typeof value.is_error === "boolean" ? { isError: value.is_error } : {}),
      ...(typeof value.result === "string" ? { result: value.result } : {}),
      ...(typeof value.total_cost_usd === "number" ? { costUsd: value.total_cost_usd } : {}),
      ...(typeof value.session_id === "string" ? { sessionId: value.session_id } : {}),
    };
    return [event];
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
