import { Effect } from "effect";
import { type AgentRecord, Registry, type RegistryShape } from "./registry.js";
import { PiHost, type PiHostShape } from "./runtime.js";

/**
 * notify.ts — push a finished background run back into the parent conversation.
 *
 * One custom message per settled run; an interrupted run sends nothing (interruption is
 * not a typed failure and is never routed here). Rendering is display-only — the LLM still
 * receives the full content.
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
  id: string,
  status: "done" | "error",
  body: string,
): Effect.Effect<void, never, RegistryShape | PiHostShape> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const host = yield* PiHost;
    // The record was written before the run started; if it somehow is gone, there is
    // nothing to notify about — stay in the never-error contract.
    const record: AgentRecord | undefined = yield* registry
      .get(id)
      .pipe(Effect.catchTag("AgentNotFound", () => Effect.succeed(undefined)));
    if (record === undefined) return;
    const durationMs = Date.now() - record.startedAt;
    const details: SubagentResultDetails = {
      id: record.id,
      name: record.name,
      type: record.type,
      status,
      description: record.description,
      durationMs,
      toolUses: record.toolUses,
    };
    const content = `${record.name} · ${status} · ${record.description}\n\n${body}`;
    yield* Effect.sync(() =>
      host.sendMessage(
        { customType: SUBAGENT_RESULT_TYPE, content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  });
