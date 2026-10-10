import { Effect } from "effect";
import type { AgentSnapshot } from "./agent.js";
import { PiHost, type PiHostShape } from "./runtime.js";

/**
 * notify.ts — push a finished background run back into the parent conversation.
 *
 * One custom message per settled run; an interrupted run sends nothing (interruption is not a
 * typed failure and is never routed here). Rendering is display-only — the LLM still receives
 * the full content.
 */

export const SUBAGENT_RESULT_TYPE = "subagent-result";

export interface SubagentResultDetails {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly description: string;
  readonly durationMs: number;
  readonly toolUses: number;
}

export const notifyResult = (
  snapshot: AgentSnapshot,
  status: "done" | "error",
  body: string,
): Effect.Effect<void, never, PiHostShape> =>
  Effect.gen(function* () {
    const host = yield* PiHost;
    const durationMs = Date.now() - snapshot.startedAt;
    const details: SubagentResultDetails = {
      id: snapshot.id,
      name: snapshot.name,
      type: snapshot.type,
      status,
      description: snapshot.description,
      durationMs,
      toolUses: snapshot.toolUses,
    };
    const content = `${snapshot.name} · ${status} · ${snapshot.description}\n\n${body}`;
    yield* Effect.sync(() =>
      host.sendMessage(
        { customType: SUBAGENT_RESULT_TYPE, content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  });

