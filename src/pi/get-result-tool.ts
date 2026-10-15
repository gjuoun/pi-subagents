import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { type AgentSnapshot, formatElapsed } from "../domain/agent.js";
import type { V2Error } from "../domain/errors.js";
import type { AppRuntime } from "../layers.js";
import { AgentRegistry } from "../services/agent-registry.js";
import { runTool } from "./boundary.js";

/**
 * get-result-tool.ts — the `get_subagent_result` tool (JW-166).
 *
 * Status and final text of a subagent by id or handle; `wait` blocks until it settles,
 * `verbose` adds the child's conversation. Reading a settled result marks it consumed, so a
 * still-pending completion message for it is never sent.
 */

export const GET_RESULT_TOOL_NAME = "get_subagent_result";

export const GET_RESULT_DESCRIPTION =
  "Check status and retrieve a background agent's full result — its completion message carries only a preview. Use the agent ID returned by Agent, or its handle.";

export const GET_RESULT_PARAMS = Type.Object({
  agent_id: Type.String({ description: "The agent ID returned by Agent, or its handle (its name, else its type)." }),
  wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to finish before returning." })),
  verbose: Type.Optional(
    Type.Boolean({ description: "If true, include the agent's full conversation (messages and tool calls)." }),
  ),
});
type Args = Static<typeof GET_RESULT_PARAMS>;
const Params = GET_RESULT_PARAMS;

/** The plain-text report for one snapshot. */
export function formatResult(s: AgentSnapshot): string {
  const duration = s.finishedAt !== undefined ? formatElapsed(s.finishedAt - s.startedAt) : "running";
  const header =
    `Agent: ${s.id} (${s.handle})\n` +
    `Type: ${s.type} | Status: ${s.status} | Turns: ${s.turns} | Tool uses: ${s.toolUses} | Duration: ${duration}\n` +
    `Description: ${s.description}\n\n`;
  if (s.status === "running" || s.status === "queued") {
    return `${header}Agent is still ${s.status}. Use wait: true or check back later.`;
  }
  if (s.status === "error") return `${header}Error: ${s.lastText || "unknown error"}`;
  return header + (s.lastText.trim() || "No output.");
}

export class GetResultTool {
  readonly #getRuntime: () => AppRuntime;

  constructor(getRuntime: () => AppRuntime) {
    this.#getRuntime = getRuntime;
  }

  get definition(): ToolDefinition<typeof Params, undefined> {
    return defineTool({
      name: GET_RESULT_TOOL_NAME,
      label: "Get Agent Result",
      description: GET_RESULT_DESCRIPTION,
      promptSnippet: "Check status and retrieve results from a background agent",
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
    const snapshot = params.wait === true ? yield* registry.awaitSettled(agent) : yield* agent.snapshot;
    const settled = snapshot.status !== "running" && snapshot.status !== "queued";
    if (settled) yield* registry.consume(agent.id);
    const report = formatResult(snapshot);
    if (params.verbose !== true) return report;
    const conversation = agent.session.conversation();
    return conversation ? `${report}\n\n--- Agent Conversation ---\n${conversation}` : report;
  });
}
