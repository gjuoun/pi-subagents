/**
 * get-subagent-result.ts — the `get_subagent_result` tool.
 *
 * The full result behind a completion notification's preview, with an optional wait for a
 * running or queued agent. Reading a finished result marks it consumed and cancels its held
 * notification, so the model is not told the same thing twice.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isTopLevelAgent } from "../agent/agent-manager.js";
import { getAgentConversation } from "../agent/agent-runner.js";
import { getStatusNote, partialOutputSuffix } from "../agent/session/status-note.js";
import { abortable } from "../lib/abortable.js";
import { SUBAGENT_TOOL_NAMES } from "../lib/tool-names.js";
import { formatCost, formatDuration } from "../lib/ui/format.js";
import { getLifetimeCost, getSessionContextPercent } from "../lib/usage.js";
import { getDisplayName } from "../ui/agent-display.js";
import { formatLifetimeTokens } from "../ui/agent-status.js";
import { textResult } from "../ui/notifications.js";
import type { ToolsDeps } from "./deps.js";

export function createGetSubagentResultTool(deps: ToolsDeps) {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = deps.resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested. Cancellation stops only this tool
      // call; the background agent keeps running and remains unconsumed so its
      // completion notification can still be delivered.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so poll until they leave the queue, then await like a running one.
      if (params.wait && (record.status === "running" || record.status === "queued")) {
        while (record.status === "queued") {
          await abortable(
            new Promise<void>((resolve) => setTimeout(resolve, deps.queueWaitPollMs)),
            signal,
          );
        }
        if (record.promise) await abortable(record.promise, signal);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (deps.context.showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        deps.cancelNudge(params.agent_id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  });
}
