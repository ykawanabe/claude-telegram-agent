import { describe, expect, test } from "bun:test";
import { parseBotCommand } from "./bot-feature";

describe("parseBotCommand", () => {
  test("rejects empty and non-command text", () => {
    expect(parseBotCommand("")).toBeNull();
    expect(parseBotCommand("hello")).toBeNull();
    expect(parseBotCommand(" /pair code")).toBeNull();
  });

  test("lowercases the command and strips its @bot suffix", () => {
    expect(parseBotCommand("/PaIr@MyTelegramBot AB7K-1234")).toEqual({
      command: "/pair",
      args: "AB7K-1234",
    });
  });

  test("uses only the first literal ASCII space as the separator", () => {
    expect(parseBotCommand("/pair  AB7K-1234 ")).toEqual({
      command: "/pair",
      args: " AB7K-1234 ",
    });
    expect(parseBotCommand("/PAIR\tAB7K-1234")).toEqual({
      command: "/pair\tab7k-1234",
      args: "",
    });
  });

  test("returns the exact untrimmed argument remainder", () => {
    expect(parseBotCommand("/do first line\nsecond line  ")).toEqual({
      command: "/do",
      args: "first line\nsecond line  ",
    });
  });

  test("returns empty args when no separator is present", () => {
    expect(parseBotCommand("/status")).toEqual({
      command: "/status",
      args: "",
    });
  });
});
