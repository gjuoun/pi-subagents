import type { Effect } from "effect";
import type { RunFailed } from "./errors.js";
import type { ForkSource } from "./fork.js";

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
  /**
   * Tool selectors as written in the agent file (names, `ext:<ext>`, `ext:<ext>/<tool>`);
   * undefined means every registered tool. The subagent tools are always withheld.
   */
  readonly tools?: ReadonlyArray<string>;
  /** Exact "provider/id" for the child model; undefined inherits the parent's model. */
  readonly model?: string;
  readonly thinking?: string;
  /** false keeps pi's skills index out of the child (agent file `skills: false`). */
  readonly skills?: boolean;
  /** Turn cap from the agent file; undefined is unlimited. */
  readonly maxTurns?: number;
  /** Set for `subagent_type: "fork"`: branch the parent's conversation instead of starting fresh. */
  readonly fork?: ForkSource;
}

/** One block of a message as the viewer reads it. */
export interface ViewerBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

/** One message as the viewer reads it: role plus its blocks (a string content becomes one text block). */
export interface ViewerMessage {
  readonly role: string;
  readonly blocks: ReadonlyArray<ViewerBlock>;
  /** For a toolResult: which tool produced it. */
  readonly toolName?: string;
}

/** The steer a child receives when it reaches its turn cap. */
export const WRAP_UP_MESSAGE = "You have reached your turn limit. Wrap up immediately — provide your final answer now.";

/** Turns a child gets after the wrap-up steer before a hard abort: max(10, ceil(cap * 0.25)). */
export function graceTurns(maxTurns: number): number {
  return Math.max(10, Math.ceil(maxTurns * 0.25));
}

/** What one child turn produced: its answer text and the tools it called. */
export interface RunOutcome {
  readonly answer: string;
  readonly toolUses: number;
  readonly lastTool?: string;
  /** Turns this run took (one per assistant response). */
  readonly turns: number;
  /** The run reached its cap and was steered to wrap up. */
  readonly wrappedUp: boolean;
  /** The grace window ran out and the run was aborted. */
  readonly hardStopped: boolean;
}

/** Fired once per `tool_execution_start` while a turn runs. */
export type ActivityListener = (toolName: string) => void;

/** Running token total (input + output + cache writes) and context-window use, after each response. */
export interface ChildUsage {
  readonly tokens: number;
  readonly contextPercent?: number;
}
export type UsageListener = (usage: ChildUsage) => void;

export interface ChildSession {
  /** The child session name: "<type>#<id8>". */
  readonly name: string;
  /** Run one prompt, ending in the child's own final answer or RunFailed. */
  prompt(input: string, onActivity?: ActivityListener, onUsage?: UsageListener): Effect.Effect<RunOutcome, RunFailed>;
  /** The model id the child runs on, when known. */
  readonly modelId: string | undefined;
  /** The child's thinking level, when known. */
  readonly thinking: string | undefined;
  /** The child's conversation as plain text (user, assistant, tool calls, tool results). */
  conversation(): string;
  /** The child's messages as plain data, for the conversation viewer. */
  messages(): ReadonlyArray<ViewerMessage>;
  /** Called on every session event (streaming included); returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Inject a user message into the running turn, after its current tool call. */
  steer(message: string): Effect.Effect<void, RunFailed>;
  abort(): void;
  dispose(): void;
}
