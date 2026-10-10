import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { ChildSession } from "./child-session.js";
import { RunFailed } from "./errors.js";
import { Registry, type RegistryShape } from "./registry.js";

/**
 * run.ts — the record transitions around one child run, ending in text or RunFailed.
 *
 * The session plumbing (subscribe, prompt, answer extraction, final-turn error) lives in
 * ChildSession; this module owns only the registry record updates. Text is the child's own
 * final assistant text, so a resume that produced nothing never inherits a prior turn's
 * answer. Interruption aborts the session and marks the record aborted.
 */

export const runOnce = (
  id: string,
  session: AgentSession,
  prompt: string,
): Effect.Effect<string, RunFailed, RegistryShape> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const child = new ChildSession(session, id, "");

    yield* registry.updateRecord(id, (r) => ({
      ...r,
      status: "running" as const,
      startedAt: Date.now(),
      finishedAt: undefined,
      lastTool: undefined,
    }));

    let toolUses = 0;
    let lastTool: string | undefined;
    const outcome = yield* child.prompt(prompt, (tool) => {
      toolUses += 1;
      lastTool = tool;
    }).pipe(
      // A rejected prompt or a failed final turn must not leave the record "running" forever
      // — that would keep hasRunning() true (waitForAll hangs, resume returns AgentBusy, the
      // widget never settles).
      Effect.tapErrorTag("RunFailed", () =>
        registry.updateRecord(id, (r) => ({
          ...r,
          status: "error" as const,
          finishedAt: Date.now(),
          runs: r.runs + 1,
          toolUses,
          lastTool,
        })),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          yield* registry.updateRecord(id, (r) => ({ ...r, status: "aborted" as const, finishedAt: Date.now() }));
          yield* Effect.sync(() => child.abort());
        }),
      ),
    );

    yield* registry.updateRecord(id, (r) => ({
      ...r,
      status: "done" as const,
      finishedAt: Date.now(),
      runs: r.runs + 1,
      lastText: outcome.answer,
      toolUses: outcome.toolUses,
      lastTool: outcome.lastTool,
    }));
    return outcome.answer;
  });
