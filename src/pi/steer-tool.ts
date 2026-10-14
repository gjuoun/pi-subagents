import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Effect } from "effect";
import type { V2Error } from "../domain/errors.js";
import type { AppRuntime } from "../layers.js";
import { AgentRegistry } from "../services/agent-registry.js";
import { runTool } from "./boundary.js";

/**
 * steer-tool.ts — the `steer_subagent` tool (JW-166): one user message into a running agent,
 * delivered after its current tool call; a queued agent gets it with its prompt.
 */

export const STEER_TOOL_NAME = "steer_subagent";

export const STEER_DESCRIPTION =
  "Send a steering message to a running agent. It interrupts the agent after its current tool execution and is injected into its conversation, redirecting its work mid-run. Only works on running (or queued) agents.";

export const STEER_PARAMS = Type.Object({
  agent_id: Type.String({ description: "The agent ID to steer, or its handle (its name, else its type)." }),
  message: Type.String({ description: "The message; it appears as a user message in the agent's conversation." }),
});
type Args = Static<typeof STEER_PARAMS>;
const Params = STEER_PARAMS;

export class SteerTool {
  readonly #getRuntime: () => AppRuntime;

  constructor(getRuntime: () => AppRuntime) {
    this.#getRuntime = getRuntime;
  }

  get definition(): ToolDefinition<typeof Params, undefined> {
    return defineTool({
      name: STEER_TOOL_NAME,
      label: "Steer Agent",
      description: STEER_DESCRIPTION,
      promptSnippet: "Send a steering message to redirect a running background agent",
      parameters: Params,
      execute: async (_id: string, params: Args, signal: AbortSignal | undefined, _u: unknown, _ctx: ExtensionContext) =>
        runTool(this.#getRuntime(), program(params), signal),
    });
  }
}

function program(params: Args): Effect.Effect<string, V2Error, AgentRegistry> {
  return Effect.gen(function* () {
    const registry = yield* AgentRegistry;
    const agent = yield* registry.find(params.agent_id);
    const outcome = yield* agent.steer(params.message);
    return outcome === "sent"
      ? `Steering message sent to agent ${agent.id} (${agent.handle}). It is processed after the current tool execution.`
      : `Agent ${agent.id} (${agent.handle}) is queued; the message is delivered with its prompt when it starts.`;
  });
}
