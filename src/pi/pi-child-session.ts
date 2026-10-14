import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  type ActivityListener,
  type ChildSession,
  graceTurns,
  type RunOutcome,
  type UsageListener,
  type ViewerBlock,
  type ViewerMessage,
  WRAP_UP_MESSAGE,
} from "../domain/child-session.js";
import { type RunFailed, SessionError } from "../domain/errors.js";

/**
 * pi-child-session.ts — the pi implementation of the ChildSession port.
 *
 * The pi boundary: `prompt` reads one turn and answers with the child's own text; it never
 * touches the registry. The whole construction runs inside an AsyncLocalStorage marker so pi
 * loading extensions FOR THE CHILD makes v2's factory return early instead of nesting a runtime.
 */

const childSessionContext = new AsyncLocalStorage<boolean>();

/** True while pi is loading extensions for a child — v2 must not nest a runtime. */
export function isChildContext(): boolean {
  return childSessionContext.getStore() === true;
}

/** Run `fn` inside the child-context marker (pi's extension loader observes it). */
export function runInChildContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}

export class PiChildSession implements ChildSession {
  readonly #session: AgentSession;
  readonly #id: string;
  readonly #type: string;
  readonly #maxTurns: number | undefined;

  constructor(session: AgentSession, id: string, type: string, maxTurns?: number) {
    this.#session = session;
    this.#id = id;
    this.#type = type;
    this.#maxTurns = maxTurns;
  }

  get modelId(): string | undefined {
    return (this.#session as { model?: { id?: string } }).model?.id;
  }

  get thinking(): string | undefined {
    return (this.#session as { thinkingLevel?: string }).thinkingLevel;
  }

  /** Lifetime token total across runs (input + output + cache writes). */
  #tokens = 0;

  /** The child session name: "<type>#<id8>". */
  get name(): string {
    return `${this.#type}#${this.#id.slice(0, 8)}`;
  }

  /**
   * Run one prompt, ending in the child's own final answer or RunFailed. Text is bounded by
   * the message count before the prompt, so a resume that produced nothing never inherits a
   * prior turn's answer. A final turn that stopped with an error, or hit the output-token
   * limit with no text, is a failure.
   */
  prompt(input: string, onActivity?: ActivityListener, onUsage?: UsageListener): Effect.Effect<RunOutcome, RunFailed> {
    return Effect.gen({ self: this }, function* () {
      const session = this.#session;
      const id = this.#id;
      const maxTurns = this.#maxTurns;
      const startIndex = session.messages.length;
      let accumulated = "";
      let toolUses = 0;
      let lastTool: string | undefined;
      let turns = 0;
      let wrappedUp = false;
      let hardStopped = false;

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        // The turn cut off by the hard abort also ends; it does not count as a turn taken.
        if (event.type === "turn_end" && !hardStopped) {
          turns += 1;
          if (maxTurns !== undefined) {
            if (!wrappedUp && turns >= maxTurns) {
              wrappedUp = true;
              void session.steer(WRAP_UP_MESSAGE);
            } else if (wrappedUp && !hardStopped && turns >= maxTurns + graceTurns(maxTurns)) {
              hardStopped = true;
              void session.abort();
            }
          }
        }
        if (event.type === "message_start" && event.message.role === "assistant") accumulated = "";
        if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = (event.message as { usage?: { input?: number; output?: number; cacheWrite?: number } }).usage;
          if (usage) this.#tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
          const percent = (session as { getContextUsage?: () => { percent: number | null } | undefined })
            .getContextUsage?.()?.percent;
          onUsage?.({ tokens: this.#tokens, ...(percent != null && { contextPercent: percent }) });
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          accumulated += event.assistantMessageEvent.delta;
        }
        if (event.type === "tool_execution_start") {
          toolUses += 1;
          lastTool = event.toolName;
          onActivity?.(event.toolName);
        }
      });

      yield* Effect.tryPromise({
        try: () => session.prompt(input),
        catch: (error) => SessionError.RunFailed({ id, reason: error instanceof Error ? error.message : String(error) }),
      }).pipe(Effect.ensuring(Effect.sync(() => unsubscribe())));

      const answer = accumulated.trim() || lastAssistantText(session, startIndex);
      if (hardStopped) return { answer, toolUses, lastTool, turns, wrappedUp, hardStopped };
      const failure = finalTurnError(session, startIndex);
      if (failure !== undefined) {
        return yield* Effect.fail(SessionError.RunFailed({ id, reason: failure }));
      }
      return { answer, toolUses, lastTool, turns, wrappedUp, hardStopped };
    });
  }

  conversation(): string {
    const parts: string[] = [];
    for (const msg of this.#session.messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content as ReadonlyArray<{ type?: string; text?: string }>);
        if (text.trim()) parts.push(`[User]: ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const blocks = msg.content as ReadonlyArray<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
        const text = extractText(blocks).trim();
        if (text) parts.push(`[Assistant]: ${text}`);
        for (const b of blocks) {
          if (b.type === "toolCall") parts.push(`[Tool Call]: ${b.name ?? "unknown"} ${JSON.stringify(b.arguments ?? {})}`);
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(msg.content as ReadonlyArray<{ type?: string; text?: string }>);
        const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        parts.push(`[Tool Result (${(msg as { toolName?: string }).toolName ?? "tool"})]: ${clipped}`);
      }
    }
    return parts.join("\n\n");
  }

  messages(): ReadonlyArray<ViewerMessage> {
    return this.#session.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      .map((m) => {
        const content = (m as { content?: unknown }).content;
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : ((content ?? []) as ViewerBlock[]);
        return { role: m.role, blocks, toolName: (m as { toolName?: string }).toolName };
      });
  }

  onChange(listener: () => void): () => void {
    return this.#session.subscribe(() => listener());
  }

  steer(message: string): Effect.Effect<void, RunFailed> {
    return Effect.tryPromise({
      try: () => this.#session.steer(message),
      catch: (error) => SessionError.RunFailed({ id: this.#id, reason: error instanceof Error ? error.message : String(error) }),
    });
  }

  abort(): void {
    void this.#session.abort();
  }

  dispose(): void {
    this.#session.dispose();
  }
}

function extractText(content: ReadonlyArray<{ type?: string; text?: string }>): string {
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

/** Last non-empty assistant text at or after startIndex. */
function lastAssistantText(session: AgentSession, startIndex: number): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const value = extractText(msg.content as ReadonlyArray<{ type?: string; text?: string }>).trim();
    if (value) return value;
  }
  return "";
}

/** The failure reason of this run's final turn, if it failed. */
function finalTurnError(session: AgentSession, startIndex: number): string | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content as ReadonlyArray<{ type?: string; text?: string }>).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}
