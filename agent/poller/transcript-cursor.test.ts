import { describe, expect, test } from "bun:test";
import { createTranscriptCursor } from "./transcript-cursor";

describe("TranscriptCursor", () => {
  test("retains a split tail and returns recognized events in wire order", () => {
    const cursor = createTranscriptCursor();

    expect(cursor.push('{"type":"assist')).toEqual([]);
    expect(cursor.push([
      'ant","message":{"content":[{"type":"text","text":"first"},{"type":"tool_use"},{"type":"text","text":"second"}]}}',
      '{"type":"result","is_error":false,"result":"ok","total_cost_usd":0.25,"session_id":"session-1"}',
      "",
    ].join("\n"))).toEqual([
      { type: "assistant", text: "first" },
      { type: "assistant", text: "second" },
      {
        type: "result",
        isError: false,
        result: "ok",
        costUsd: 0.25,
        sessionId: "session-1",
      },
    ]);
  });

  test("finish parses a final unterminated record exactly once", () => {
    const cursor = createTranscriptCursor();
    cursor.push('{"type":"assistant","message":{"content":[{"type":"text","text":"tail"}]}}');

    expect(cursor.finish()).toEqual([{ type: "assistant", text: "tail" }]);
    expect(cursor.finish()).toEqual([]);
  });

  test("ignores blanks, noise, nonobjects, unrecognized events, and empty text blocks", () => {
    const cursor = createTranscriptCursor();
    expect(cursor.push([
      "",
      "startup noise",
      "null",
      "42",
      "[]",
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":""},{"type":"thinking","text":"hidden"}]}}',
      "",
    ].join("\n"))).toEqual([]);
  });

  test("result fields are optional and invalid field values are omitted", () => {
    const cursor = createTranscriptCursor();
    expect(cursor.push([
      '{"type":"result"}',
      '{"type":"result","is_error":"yes","result":3,"total_cost_usd":"free","session_id":9}',
      "",
    ].join("\n"))).toEqual([
      { type: "result" },
      { type: "result" },
    ]);
  });

  test("reset discards an incomplete tail without producing an event", () => {
    const cursor = createTranscriptCursor();
    cursor.push('{"type":"assistant"');
    cursor.reset();

    expect(cursor.push('{"type":"result","total_cost_usd":1}\n')).toEqual([
      { type: "result", costUsd: 1 },
    ]);
    expect(cursor.finish()).toEqual([]);
  });
});
