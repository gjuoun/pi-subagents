/**
 * tool-names.ts — the tool names this extension registers.
 *
 * Hoisted out of `agent/session/extension-scope.ts`, where they had ridden along with the
 * Step 13 scoping cluster. They belong in `lib/` because two unrelated domains need them and
 * neither has anything else to do with the other: `workflow/collisions.ts` (which stands down
 * when another extension already took the workflow tool's name) and the agent domain (which
 * must keep those names out of a subagent's tool scope).
 */

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
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
export const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);
