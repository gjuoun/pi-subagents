import { randomBytes } from "node:crypto";
import type { AgentSession, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Effect, FiberMap } from "effect";
import { GENERAL_PURPOSE_NAME, resolveType } from "./agent-types.js";
import { runTool } from "./boundary.js";
import { AgentBusy, AgentNotFound, type V2Error } from "./errors.js";
import { notifyResult } from "./notify.js";
import { type AgentRecord, Registry, type RegistryShape } from "./registry.js";
import { runOnce } from "./run.js";
import type { AppRuntime, PiHostShape } from "./runtime.js";
import { spawn } from "./spawn.js";

/**
 * tool.ts — the single Agent tool.
 *
 * The execute boundary is the only place a Promise meets an Effect here: the effectful
 * program is handed to runTool, which folds the Exit back into an AgentToolResult.
 */

export const AGENT_TOOL_NAME = "Agent";

const AGENT_TOOL_DESCRIPTION =
  "Launch a subagent to work on a task autonomously and return its final answer. " +
  "The subagent runs in its own session with its own tools. Use it to delegate a " +
  "self-contained task and get back a concise result.";

const AgentParams = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task." }),
  prompt: Type.String({ description: "The task for the subagent to perform." }),
  subagent_type: Type.Optional(
    Type.String({ description: "The type of subagent to use. Defaults to general-purpose." }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({ description: "Run the subagent in the background; its result arrives as a message." }),
  ),
  resume: Type.Optional(
    Type.String({ description: "An existing agent id to continue instead of spawning a new one." }),
  ),
});
type AgentArgs = Static<typeof AgentParams>;

export const createAgentTool = (
  getRuntime: () => AppRuntime,
): ToolDefinition<typeof AgentParams, undefined> =>
  defineTool({
    name: AGENT_TOOL_NAME,
    label: "Agent",
    description: AGENT_TOOL_DESCRIPTION,
    parameters: AgentParams,
    execute: async (
      _toolCallId: string,
      params: AgentArgs,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      const program = agentProgram(ctx, params);
      return runTool(getRuntime(), program, signal);
    },
  });

/** The allocate -> spawn -> run -> return-text program for one foreground call. */
export function agentProgram(
  ctx: ExtensionContext,
  params: AgentArgs,
): Effect.Effect<string, V2Error, RegistryShape | PiHostShape> {
  return Effect.gen(function* () {
    const registry = yield* Registry;

    if (params.resume !== undefined) {
      const record = yield* registry.get(params.resume);
      if (record.status === "running") {
        return yield* Effect.fail(new AgentBusy({ id: record.id, name: record.name }));
      }
      const entry = yield* registry.getEntry(record.id);
      if (entry === undefined) {
        return yield* Effect.fail(new AgentNotFound({ id: record.id }));
      }
      return yield* runAgentRun(registry, record.id, entry.session, params);
    }

    const agentType = yield* resolveType(ctx.cwd ?? process.cwd(), params.subagent_type ?? GENERAL_PURPOSE_NAME);
    const id = randomBytes(4).toString("hex");

    const session = yield* spawn(ctx, {
      id,
      type: agentType.name,
      systemPrompt: agentType.systemPrompt,
      tools: agentType.tools,
      model: agentType.model,
      thinking: agentType.thinking,
    });
    const record: AgentRecord = {
      id,
      type: agentType.name,
      name: agentType.name,
      description: params.description,
      status: "running",
      runs: 0,
      startedAt: Date.now(),
      lastText: "",
      toolUses: 0,
    };
    yield* registry.putRecord(record);
    yield* registry.putEntry(id, { session });

    return yield* runAgentRun(registry, id, session, params);
  });
}

/** Run once on a fresh or resumed session; fork it when run_in_background is set. */
function runAgentRun(
  registry: RegistryShape,
  id: string,
  session: AgentSession,
  params: AgentArgs,
): Effect.Effect<string, V2Error, RegistryShape | PiHostShape> {
  return Effect.gen(function* () {
    if (params.run_in_background === true) {
      yield* FiberMap.run(
        registry.fibers,
        id,
        runOnce(id, session, params.prompt).pipe(
          Effect.tap((answer) => notifyResult(id, "done", answer)),
          Effect.catchTag("RunFailed", (error) => notifyResult(id, "error", error.plain.message)),
        ),
      );
      const record = yield* registry.get(id);
      return `Started ${record.type} (id ${id}) in the background — its result will arrive as a message.`;
    }
    return yield* runOnce(id, session, params.prompt);
  });
}
