/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  WORKFLOW: "SubagentWorkflow",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
  /** Toggleable Jev agent selector — parent-side only (see EXCLUDED_TOOL_NAMES). */
  JEV: "jev",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
export const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);
