import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ActivityListener, ChildSession, RunOutcome } from "../domain/child-session.js";
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

  constructor(session: AgentSession, id: string, type: string) {
    this.#session = session;
    this.#id = id;
    this.#type = type;
  }

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
  prompt(input: string, onActivity?: ActivityListener): Effect.Effect<RunOutcome, RunFailed> {
    return Effect.gen({ self: this }, function* () {
      const session = this.#session;
      const id = this.#id;
      const startIndex = session.messages.length;
      let accumulated = "";
      let toolUses = 0;
      let lastTool: string | undefined;

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_start" && event.message.role === "assistant") accumulated = "";
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
      const failure = finalTurnError(session, startIndex);
      if (failure !== undefined) {
        return yield* Effect.fail(SessionError.RunFailed({ id, reason: failure }));
      }
      return { answer, toolUses, lastTool };
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
