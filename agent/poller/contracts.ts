/**
 * Observable events emitted by the daemon registry.
 *
 * This union deliberately mirrors the registry's six existing callbacks. It
 * carries no delivery policy or runtime behavior.
 */
export type DaemonEvent =
  | { kind: "text"; threadId: string; text: string }
  | { kind: "flush"; threadId: string; combinedText: string }
  | { kind: "turn-start"; threadId: string }
  | { kind: "turn-end"; threadId: string; costUsd: number | null; sessionId: string | null }
  | { kind: "spawn"; threadId: string; spawnedCount: number }
  | { kind: "crash"; threadId: string; crashCount: number; code: number | null; signal: string | null }
  | { kind: "spawn-failed"; threadId: string }
  | { kind: "crash-loop"; threadId: string; crashCount: number };

/** Receives daemon events synchronously. Implementations of emit must not throw. */
export interface EventSink {
  emit(event: DaemonEvent): void;
}

/** Registry operations required by resource-governance policy. */
export interface ResourceRegistryPort {
  idleCandidates(idleMs: number): string[];
  overCapacityIdleCandidates(maxWarm: number): string[];
  runTurnAndWait(
    threadId: string,
    text: string,
    timeoutMs: number,
  ): Promise<"completed" | "timeout" | "skipped">;
  isIdleEmpty(threadId: string): boolean;
  resetTopic(threadId: string): Promise<void>;
}

/** Runs one resource-governance pass. */
export interface ResourceGovernor {
  sweep(): Promise<void>;
}
