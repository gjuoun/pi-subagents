/**
 * usage-reporting.ts — the wrapper that attaches subagent spend to tool results.
 *
 * Applied to every tool registered from `index.ts`, so one hook covers all four: the Agent tool
 * (whose spends are the point) and the three that can sit between two of its calls.
 */

import type { ToolsDeps } from "./deps.js";

/**
 * Wrap a tool so its results carry back whatever subagent spend the parent
 * session has not been told about yet (see `PendingUsagePool`).
 *
 * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
 * folds it into `getSessionStats()`, which is what the footer, the statusline
 * and `/cost` read — so this is the whole of "report usage to the parent".
 *
 * Nothing is attached to a call with no tool-call id. That is the `@handle`
 * mention path (`mention-clone.ts`), which invokes this tool from a fork of the
 * conversation that is discarded moments later: the result never becomes a
 * message in the real session, so usage hung on it would be spend the user paid
 * for and nobody counted. Skipping leaves it pending for the next real result.
 */
export function withUsageReporting<T extends { execute: (...args: any[]) => any }>(tool: T, deps: ToolsDeps): T {
  return {
    ...tool,
    execute: async (toolCallId: string | undefined, ...rest: any[]) => {
      const result = await tool.execute(toolCallId, ...rest);
      if (!deps.context.reportUsage || !toolCallId) return result;
      const usage = deps.services.pendingUsage.drain();
      return usage ? { ...result, usage } : result;
    },
  };
}
export function registerToolReportingUsage(tool: any, deps: ToolsDeps): void {
  deps.pi.registerTool(withUsageReporting(tool, deps));
}
