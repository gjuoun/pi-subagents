import type { Effect } from "effect";
import type { RunFailed } from "./errors.js";

/**
 * child-session.ts — the port a child session is driven through.
 *
 * Pure interface: the pi implementation (pi/pi-child-session.ts) is the only runtime consumer
 * of the SDK, and every consumer above it (Agent, the registry, the tests) sees this contract.
 */

export interface SpawnSpec {
  readonly id: string;
  readonly type: string;
  readonly systemPrompt?: string;
  /** Built-in tool allowlist; undefined means "all built-ins minus Agent". */
  readonly tools?: ReadonlyArray<string>;
  /** "provider/id" for the child model; falls back to the parent's model. */
  readonly model?: string;
  readonly thinking?: string;
}

/** What one child turn produced: its answer text and the tools it called. */
export interface RunOutcome {
  readonly answer: string;
  readonly toolUses: number;
  readonly lastTool?: string;
}

/** Fired once per `tool_execution_start` while a turn runs. */
export type ActivityListener = (toolName: string) => void;

export interface ChildSession {
  /** The child session name: "<type>#<id8>". */
  readonly name: string;
  /** Run one prompt, ending in the child's own final answer or RunFailed. */
  prompt(input: string, onActivity?: ActivityListener): Effect.Effect<RunOutcome, RunFailed>;
  abort(): void;
  dispose(): void;
}
