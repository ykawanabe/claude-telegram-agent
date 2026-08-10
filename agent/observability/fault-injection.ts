import type { StructuredEventReporter } from "./events";

export type FaultKind = "timeout" | "disk-full" | "kill" | "corrupt-state";

export interface FaultRule {
  point: string;
  kind: FaultKind;
  /** Number of matches to inject. Defaults to one. */
  times?: number;
  /** Delay before timeout rejection. Defaults to zero. */
  delayMs?: number;
  corruption?: "truncate" | "flip-byte" | "invalid-json";
}

interface ActiveFaultRule extends FaultRule {
  remaining: number;
}

export class FaultInjectedError extends Error {
  constructor(
    readonly fault: FaultKind,
    readonly point: string,
    readonly code: "ETIMEDOUT" | "ENOSPC" | "EINJECT_KILL" | "EINJECT_CORRUPT",
  ) {
    super(`injected ${fault} fault at ${point}`);
    this.name = "FaultInjectedError";
  }
}

export interface FaultInjectorOptions {
  rules?: FaultRule[];
  reporter?: StructuredEventReporter;
  /** Tests can terminate a child process; production defaults to a safe throw. */
  onKill?: (point: string) => void;
}

/** Disabled unless rules are explicitly supplied. Rules are deterministic and
 * consumption-counted, making crash/replay tests repeatable. */
export class FaultInjector {
  private readonly rules: ActiveFaultRule[];

  constructor(private readonly options: FaultInjectorOptions = {}) {
    this.rules = (options.rules ?? []).map((rule) => ({
      ...rule,
      remaining: validateTimes(rule.times ?? 1),
    }));
  }

  static fromEnvironment(options: Omit<FaultInjectorOptions, "rules"> = {}): FaultInjector {
    return new FaultInjector({ ...options, rules: parseFaultPlan(process.env.CTA_FAULT_PLAN) });
  }

  async run<T>(point: string, operation: () => T | Promise<T>): Promise<T> {
    const rule = this.consume(point, ["timeout", "disk-full", "kill"]);
    if (!rule) return operation();
    this.report(rule);
    switch (rule.kind) {
      case "timeout":
        return await new Promise<T>((_resolve, reject) => {
          setTimeout(() => reject(new FaultInjectedError("timeout", point, "ETIMEDOUT")), rule.delayMs ?? 0);
        });
      case "disk-full":
        throw new FaultInjectedError("disk-full", point, "ENOSPC");
      case "kill":
        this.options.onKill?.(point);
        throw new FaultInjectedError("kill", point, "EINJECT_KILL");
      default:
        return operation();
    }
  }

  corruptState(point: string, state: string): string;
  corruptState(point: string, state: Uint8Array): Uint8Array;
  corruptState(point: string, state: string | Uint8Array): string | Uint8Array {
    const rule = this.consume(point, ["corrupt-state"]);
    if (!rule) return state;
    this.report(rule);
    const bytes = typeof state === "string" ? new TextEncoder().encode(state) : new Uint8Array(state);
    const corruption = rule.corruption ?? "truncate";
    let corrupted: Uint8Array;
    switch (corruption) {
      case "truncate":
        corrupted = bytes.slice(0, Math.floor(bytes.length / 2));
        break;
      case "flip-byte": {
        corrupted = new Uint8Array(bytes);
        if (corrupted.length === 0) corrupted = new Uint8Array([0xff]);
        else corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
        break;
      }
      case "invalid-json":
        corrupted = new TextEncoder().encode("{\"corrupt\":");
        break;
    }
    return typeof state === "string" ? new TextDecoder().decode(corrupted) : corrupted;
  }

  pending(): Array<{ point: string; kind: FaultKind; remaining: number }> {
    return this.rules
      .filter((rule) => rule.remaining > 0)
      .map(({ point, kind, remaining }) => ({ point, kind, remaining }));
  }

  private consume(point: string, kinds: FaultKind[]): ActiveFaultRule | undefined {
    const match = this.rules.find((rule) => rule.point === point && rule.remaining > 0 && kinds.includes(rule.kind));
    if (match) match.remaining -= 1;
    return match;
  }

  private report(rule: ActiveFaultRule): void {
    this.options.reporter?.emit("fault.injected", { point: rule.point, fault: rule.kind });
  }
}

export function parseFaultPlan(value: string | undefined): FaultRule[] {
  if (value == null || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`CTA_FAULT_PLAN is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("CTA_FAULT_PLAN must be a JSON array");
  return parsed.map((candidate, index) => validateRule(candidate, index));
}

function validateRule(candidate: unknown, index: number): FaultRule {
  if (!candidate || typeof candidate !== "object") throw new Error(`fault rule ${index} must be an object`);
  const rule = candidate as Record<string, unknown>;
  const kinds: FaultKind[] = ["timeout", "disk-full", "kill", "corrupt-state"];
  if (typeof rule.point !== "string" || rule.point.length === 0) throw new Error(`fault rule ${index} has invalid point`);
  if (typeof rule.kind !== "string" || !kinds.includes(rule.kind as FaultKind)) throw new Error(`fault rule ${index} has invalid kind`);
  const result: FaultRule = { point: rule.point, kind: rule.kind as FaultKind };
  if (rule.times != null) result.times = validateTimes(rule.times);
  if (rule.delayMs != null) {
    if (typeof rule.delayMs !== "number" || !Number.isFinite(rule.delayMs) || rule.delayMs < 0) {
      throw new Error(`fault rule ${index} has invalid delayMs`);
    }
    result.delayMs = rule.delayMs;
  }
  if (rule.corruption != null) {
    if (rule.corruption !== "truncate" && rule.corruption !== "flip-byte" && rule.corruption !== "invalid-json") {
      throw new Error(`fault rule ${index} has invalid corruption`);
    }
    result.corruption = rule.corruption;
  }
  return result;
}

function validateTimes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("fault rule times must be a non-negative integer");
  }
  return value;
}
