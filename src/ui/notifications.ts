/**
 * notifications.ts — the text and details an agent's completion produces.
 *
 * Moved out of `index.ts` as-is: the `<task-notification>` XML the orchestrating model reads,
 * the `details` object every renderer draws from, and the two small helpers only they use
 * (`textResult`, `formatToolsSuffix`). No `pi.*` call, no activation-scope state.
 *
 * **In `ui/` rather than `lib/`** because that is the only placement the layering rule allows:
 * it reads `getStatusNote` (agent), `BUILTIN_TOOL_NAMES` (config) and the
 * `AgentActivity`/`AgentDetails` shapes (ui), so `lib/` — which imports nothing internal —
 * cannot host it. Its consumers are the Agent tool's result and the `subagent-notification`
 * renderer, both surfaces.
 *
 * `textResult` is deliberately still written twice in this package: `agent/nested-tools.ts`
 * has its own copy with a different call shape. Unifying them is a DRY job, not this one.
 */

import { getStatusNote } from "../agent/session/status-note.js";
import { BUILTIN_TOOL_NAMES } from "../config/registry/agent-types.js";
import type { AgentConfig, AgentRecord, NotificationDetails } from "../lib/types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "../lib/usage.js";
import { escapeXml } from "../lib/xml.js";
import { formatLifetimeTokens, getStatusLabel } from "./agent-status.js";
import type { AgentActivity, AgentDetails } from "./agent-widget.js";

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
export function formatTaskNotification(record: AgentRecord, resultMaxLen: number, showCost = false): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";
  // Only under `showCost`: this is LLM context, and a figure the orchestrator
  // did not ask for is a figure it may start reporting unprompted.
  const cost = showCost ? getLifetimeCost(record.lifetimeUsage) : 0;
  const costXml = cost > 0 ? `<estimated_cost_usd>${cost.toFixed(4)}</estimated_cost_usd>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}${costXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: LifetimeUsage },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    // Raw, and unconditional: `tokens` is preformatted because it is one stat,
    // but a cost is joined by "·" in one surface, "," in another and "|" in a
    // third — so it travels as a number and each renderer punctuates its own.
    cost: getLifetimeCost(record.lifetimeUsage),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    // Carried unconditionally; the renderer gates on the setting. Details are
    // data, and a notification rendered before a mid-session toggle should not
    // be stuck with the old answer.
    totalCost: getLifetimeCost(record.lifetimeUsage),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}
