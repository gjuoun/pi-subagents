import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { RunFailed } from "./errors.js";
import { Registry, type RegistryShape } from "./registry.js";

/**
 * run.ts — one prompt against a child session, ending in text or RunFailed.
 *
 * Text is the child's own final assistant text (bounded by the message count before the
 * prompt, so a resume that produced nothing never inherits a prior turn's answer). A final
 * turn that stopped with an error, or hit the output-token limit with no text, is a failure.
 * Interruption aborts the session and marks the record aborted.
 */

export const runOnce = (
  id: string,
  session: AgentSession,
  prompt: string,
): Effect.Effect<string, RunFailed, RegistryShape> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const startIndex = session.messages.length;
    let text = "";
    let toolUses = 0;
    let lastTool: string | undefined;

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_start") {
        toolUses += 1;
        lastTool = event.toolName;
      }
    });

    yield* registry.updateRecord(id, (r) => ({
      ...r,
      status: "running" as const,
      startedAt: Date.now(),
      finishedAt: undefined,
      lastTool: undefined,
    }));

    yield* Effect.tryPromise({
      try: () => session.prompt(prompt),
      catch: (e) => new RunFailed({ id, reason: e instanceof Error ? e.message : String(e) }),
    }).pipe(
      // A rejected prompt must not leave the record "running" forever — that would keep
      // hasRunning() true (waitForAll hangs, resume returns AgentBusy, the widget never settles).
      Effect.tapErrorTag("RunFailed", () =>
        registry.updateRecord(id, (r) => ({
          ...r,
          status: "error" as const,
          finishedAt: Date.now(),
          runs: r.runs + 1,
          lastText: text.trim(),
          toolUses,
          lastTool,
        })),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          yield* registry.updateRecord(id, (r) => ({ ...r, status: "aborted" as const, finishedAt: Date.now() }));
          yield* Effect.sync(() => {
            void session.abort();
          });
        }),
      ),
      Effect.ensuring(Effect.sync(() => unsubscribe())),
    );

    const answer = text.trim() || lastAssistantText(session, startIndex);
    const failure = finalTurnError(session, startIndex);
    if (failure !== undefined) {
      yield* registry.updateRecord(id, (r) => ({
        ...r,
        status: "error" as const,
        finishedAt: Date.now(),
        runs: r.runs + 1,
        lastText: answer,
        toolUses,
        lastTool,
      }));
      return yield* Effect.fail(new RunFailed({ id, reason: failure }));
    }
    yield* registry.updateRecord(id, (r) => ({
      ...r,
      status: "done" as const,
      finishedAt: Date.now(),
      runs: r.runs + 1,
      lastText: answer,
      toolUses,
      lastTool,
    }));
    return answer;
  });

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
