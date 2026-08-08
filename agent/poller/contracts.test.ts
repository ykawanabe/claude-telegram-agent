import { describe, expect, test } from "bun:test";
import type { DaemonEvent } from "./contracts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

type _ExactlySixEventKinds = Expect<Equal<
  DaemonEvent["kind"],
  "text" | "flush" | "turn-start" | "turn-end" | "spawn-failed" | "crash-loop"
>>;

type _TurnEndPayloadIsFlat = Expect<Equal<
  Extract<DaemonEvent, { kind: "turn-end" }>,
  {
    kind: "turn-end";
    threadId: string;
    costUsd: number | null;
    sessionId: string | null;
  }
>>;

function route(event: DaemonEvent): string {
  switch (event.kind) {
    case "text":
      return `${event.threadId}:text:${event.text}`;
    case "flush":
      return `${event.threadId}:flush:${event.combinedText}`;
    case "turn-start":
      return `${event.threadId}:turn-start`;
    case "turn-end":
      return `${event.threadId}:turn-end:${event.costUsd}:${event.sessionId}`;
    case "spawn-failed":
      return `${event.threadId}:spawn-failed`;
    case "crash-loop":
      return `${event.threadId}:crash-loop:${event.crashCount}`;
    default:
      event satisfies never;
      throw new Error("unreachable");
  }
}

describe("DaemonEvent", () => {
  test("routes every current registry observable by its discriminant", () => {
    const events = [
      { kind: "text", threadId: "topic-1", text: "hello" },
      { kind: "flush", threadId: "topic-1", combinedText: "hello\nworld" },
      { kind: "turn-start", threadId: "topic-1" },
      { kind: "turn-end", threadId: "topic-1", costUsd: 0.25, sessionId: "session-1" },
      { kind: "spawn-failed", threadId: "topic-1" },
      { kind: "crash-loop", threadId: "topic-1", crashCount: 3 },
    ] satisfies DaemonEvent[];

    expect(events.map(route)).toEqual([
      "topic-1:text:hello",
      "topic-1:flush:hello\nworld",
      "topic-1:turn-start",
      "topic-1:turn-end:0.25:session-1",
      "topic-1:spawn-failed",
      "topic-1:crash-loop:3",
    ]);
  });

  test("preserves nullable turn-end fields", () => {
    const event = {
      kind: "turn-end",
      threadId: "topic-2",
      costUsd: null,
      sessionId: null,
    } satisfies DaemonEvent;

    expect(route(event)).toBe("topic-2:turn-end:null:null");
  });
});
