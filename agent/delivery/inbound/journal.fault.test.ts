import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileInboundJournal,
  InboundDeliveryError,
  type InboundJournalMode,
  type JournalWritePoint,
} from "./index";

interface Payload { value: string }
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "inbound-journal-fault-"));
  roots.push(value);
  return value;
}

function journal(
  rootDir: string,
  mode: InboundJournalMode = "enforced",
  failAt?: JournalWritePoint,
) {
  return new FileInboundJournal<Payload>({
    rootDir,
    mode,
    staleLockMs: 100,
    makeToken: () => "fault-token",
    faultInjector: failAt == null ? undefined : {
      onWrite(point) {
        if (point === failAt) {
          const err = new Error(`injected ${point}`) as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
      },
    },
  });
}

describe("crash recovery", () => {
  test("replays received and claimed, but quarantines dispatched as outcome unknown", () => {
    const dir = root();
    const beforeCrash = journal(dir);
    beforeCrash.receive({ messageId: "received", payload: { value: "a" } });
    beforeCrash.receive({ messageId: "claimed", payload: { value: "b" } });
    beforeCrash.claim("claimed", "dead-process");
    beforeCrash.receive({ messageId: "dispatched", payload: { value: "c" } });
    const dispatchedClaim = beforeCrash.claim("dispatched", "dead-process");
    beforeCrash.markDispatched("dispatched", dispatchedClaim.claim!.token);
    beforeCrash.receive({ messageId: "completed", payload: { value: "d" } });
    const completedClaim = beforeCrash.claim("completed", "dead-process");
    beforeCrash.markDispatched("completed", completedClaim.claim!.token);
    beforeCrash.complete("completed", completedClaim.claim!.token);

    // A fresh instance models launchd restarting after an abrupt process kill.
    const restarted = journal(dir);
    const recovery = restarted.recoverAfterCrash();
    expect(recovery.replayable.map((e) => e.messageId).sort()).toEqual(["claimed", "received"]);
    expect(recovery.recoveredClaims).toBe(1);
    expect(recovery.newlyUncertain).toBe(1);
    expect(recovery.uncertain.map((e) => e.messageId)).toContain("dispatched");
    expect(restarted.get("dispatched")?.failure?.semantic).toBe("outcome-unknown");
    expect(restarted.get("completed")?.state).toBe("completed");

    // Recovery can itself be interrupted and repeated without changing truth.
    const again = restarted.recoverAfterCrash();
    expect(again.recoveredClaims).toBe(0);
    expect(again.newlyUncertain).toBe(0);
    expect(again.replayable.map((e) => e.messageId).sort()).toEqual(["claimed", "received"]);
  });
});

describe("filesystem fault injection", () => {
  test("disk-full before rename preserves the previous durable state", () => {
    const dir = root();
    journal(dir).receive({ messageId: "m", payload: { value: "original" } });

    const diskFull = journal(dir, "enforced", "before-rename");
    expect(() => diskFull.claim("m", "worker")).toThrow("injected before-rename");

    const recovered = journal(dir);
    expect(recovered.get("m")?.state).toBe("received");
    expect(recovered.get("m")?.payload).toEqual({ value: "original" });
    expect(readdirSync(join(dir, "records")).some((name) => name.includes(".tmp."))).toBe(false);
  });

  test("journal loss is observed-only in shadow and fail-closed in enforced", () => {
    const shadowDir = root();
    const shadow = journal(shadowDir, "shadow", "before-temp-write");
    const decision = shadow.receive({ messageId: "m", payload: { value: "x" } });
    expect(decision).toMatchObject({
      classification: "journal-error",
      action: "process",
      wouldEnforce: "fail-closed",
      journaled: false,
      failureSemantic: "loss",
    });

    const enforced = journal(root(), "enforced", "before-temp-write");
    try {
      enforced.receive({ messageId: "m", payload: { value: "x" } });
      throw new Error("expected receive to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(InboundDeliveryError);
      expect((error as InboundDeliveryError).semantic).toBe("loss");
    }
  });

  test("a torn/corrupt record is quarantined as loss, never silently deleted or replayed", () => {
    const dir = root();
    const before = journal(dir);
    before.receive({ messageId: "corrupt-me", payload: { value: "important" } });
    const recordsDir = join(dir, "records");
    const recordPath = join(recordsDir, readdirSync(recordsDir).find((name) => name.endsWith(".json"))!);
    const original = readFileSync(recordPath, "utf8");
    writeFileSync(recordPath, original.slice(0, Math.floor(original.length / 2)));

    const restarted = journal(dir);
    const recovery = restarted.recoverAfterCrash();
    expect(recovery.replayable).toEqual([]);
    expect(recovery.losses).toHaveLength(1);
    expect(recovery.losses[0]).toMatchObject({ semantic: "loss", reason: "corrupt-record" });
    expect(recovery.losses[0].quarantinePath).toBeDefined();
    expect(readFileSync(recovery.losses[0].quarantinePath!, "utf8")).toBe(original.slice(0, Math.floor(original.length / 2)));
    expect(readdirSync(join(dir, "quarantine"))).toHaveLength(2);

    // The failure semantic survives another restart; quarantine is not merely
    // a one-shot log line from the process that discovered corruption.
    const afterAnotherRestart = journal(dir);
    expect(afterAnotherRestart.listIssues()).toHaveLength(1);
    expect(afterAnotherRestart.summary()).toMatchObject({ knownLosses: 1, corruptRecords: 1 });
    expect(afterAnotherRestart.recoverAfterCrash().losses).toHaveLength(1);
  });

  test("orphan temp files from a mid-write kill are ignored", () => {
    const dir = root();
    const j = journal(dir);
    j.receive({ messageId: "safe", payload: { value: "durable" } });
    writeFileSync(join(dir, "records", "garbage.json.tmp.123.crash"), "{\"torn\":");

    const recovery = journal(dir).recoverAfterCrash();
    expect(recovery.replayable.map((entry) => entry.messageId)).toEqual(["safe"]);
    expect(recovery.losses).toEqual([]);
  });

  test("a lock left by a killed process is recovered", () => {
    const dir = root();
    const lockDir = join(dir, ".journal.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 999_999_999, acquiredAt: "2000-01-01T00:00:00.000Z" }));

    const j = journal(dir);
    expect(j.receive({ messageId: "after-kill", payload: { value: "ok" } }).classification).toBe("new");
    expect(j.get("after-kill")?.state).toBe("received");
  });
});
