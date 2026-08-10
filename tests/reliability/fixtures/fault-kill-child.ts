import { FaultInjector } from "../../../agent/observability";

const injector = new FaultInjector({
  rules: [{ point: "child.after-persist", kind: "kill" }],
  onKill: () => process.kill(process.pid, "SIGKILL"),
});

await injector.run("child.after-persist", () => {
  process.stderr.write("operation unexpectedly ran\n");
});
