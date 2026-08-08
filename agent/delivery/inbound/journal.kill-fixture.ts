import { FileInboundJournal, type JournalWritePoint } from "./index";

const rootDir = process.argv.at(-2);
const stage = process.argv.at(-1);
if (!rootDir || (stage !== "claimed" && stage !== "dispatched")) {
  throw new Error("usage: journal.kill-fixture.ts ROOT claimed|dispatched");
}

let durableWrites = 0;
const killAfter = stage === "claimed" ? 2 : 3;
const journal = new FileInboundJournal<{ value: string }>({
  rootDir,
  mode: "enforced",
  staleLockMs: 100,
  makeToken: () => "child-token",
  faultInjector: {
    onWrite(point: JournalWritePoint) {
      if (point !== "after-directory-fsync") return;
      durableWrites += 1;
      if (durableWrites === killAfter) process.kill(process.pid, "SIGKILL");
    },
  },
});

journal.receive({ messageId: stage, payload: { value: stage } });
const claim = journal.claim(stage, `child:${process.pid}`);
journal.markDispatched(stage, claim.claim!.token);
throw new Error("child fixture did not reach the configured kill point");
