import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Effect } from "effect";
import type { Agent } from "../domain/agent.js";
import type { V2Error } from "../domain/errors.js";
import type { AppRuntime } from "../layers.js";
import { AgentRegistry, type AgentRegistryShape } from "../services/agent-registry.js";
import { AgentTypeCatalog, GENERAL_PURPOSE_NAME } from "../services/agent-type-catalog.js";
import { ParentContext, type ParentContextShape } from "../services/parent-context.js";
import { runTool } from "./boundary.js";
import type { PiHost } from "./pi-result-notifier.js";

/**
 * agent-tool.ts — the single Agent tool.
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

/** Run once on a fresh or resumed agent; fork it when run_in_background is set. */
function runAgent(
  registry: AgentRegistryShape,
  agent: Agent,
  params: AgentArgs,
): Effect.Effect<string, V2Error, AgentRegistry | PiHost> {
  return params.run_in_background === true
    ? registry.runInBackground(agent, params.prompt)
    : agent.run(params.prompt);
}

export class AgentTool {
  readonly #getRuntime: () => AppRuntime;

  constructor(getRuntime: () => AppRuntime) {
    this.#getRuntime = getRuntime;
  }

  get definition(): ToolDefinition<typeof AgentParams, undefined> {
    return defineTool({
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
        return runTool(this.#getRuntime(), this.program(ctx, params), signal);
      },
    });
  }

  /** The resolve -> create/find -> run program for one Agent call. */
  private program(ctx: ExtensionContext, params: AgentArgs): Effect.Effect<string, V2Error, AgentRegistry | PiHost> {
    return Effect.gen(function* () {
      const registry = yield* AgentRegistry;

      if (params.resume !== undefined) {
        const agent = yield* registry.find(params.resume);
        return yield* runAgent(registry, agent, params);
      }

      const catalog = yield* AgentTypeCatalog.load(ctx.cwd ?? process.cwd());
      const agentType = yield* catalog.resolve(params.subagent_type ?? GENERAL_PURPOSE_NAME);
      const agent = yield* registry.create(agentType, params.description);
      return yield* runAgent(registry, agent, params);
    }).pipe(Effect.provideService(ParentContext, parentContextFromExtension(ctx)));
  }
}

/** Build the per-call ParentContext from the pi extension context. */
function parentContextFromExtension(ctx: ExtensionContext): ParentContextShape {
  return {
    cwd: ctx.cwd ?? process.cwd(),
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    agentDir: getAgentDir(),
  };
}
