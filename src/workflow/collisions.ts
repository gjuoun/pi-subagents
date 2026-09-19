/**
 * collisions.ts — deciding what to do when another extension already offers a workflow
 * tool.
 *
 * Workflows are on by default, so this extension can be the *second* orchestrator in a
 * session. Two workflow tools in one spec is worse than either alone: the model has to
 * guess which to call and pays for both descriptions to find out. The other extension
 * was installed deliberately; a default of ours should not compete with it.
 *
 * A conflict is an exact name match against {@link FOREIGN_WORKFLOW_TOOL_NAMES} from a
 * tool that is not ours — exact and not a substring on purpose, since `Workflow` is a
 * common word in names that have nothing to do with orchestration
 * (`github_workflow_run`, `list_workflows`). Two shapes: a foreign tool took our name
 * (registration is first-wins, so ours never reached the registry and the rest of the
 * feature comes down with it), or one sits beside ours under a different name, which
 * the caller can withdraw. The "ours registered first" direction of the first shape is
 * undetectable: pi's registry keeps winners only.
 *
 * Split from the acting half deliberately — everything here is a pure function of the
 * tool list, so the policy is testable without a host that registers a competing
 * extension. The caller owns `getAllTools`, the notify and the `setActiveTools`.
 */

import { SUBAGENT_TOOL_NAMES } from "../lib/tool-names.js";

/**
 * Tool names that mean "another extension already orchestrates subagents".
 *
 * Our own name, because pi resolves a duplicate registration silently, and
 * Claude Code's bare `Workflow`, because a port of that tool is what a second
 * workflow extension most likely calls itself. Lowercase `workflow` is the same
 * tool by pi convention: it is what `@quintinshaw/pi-dynamic-workflows`
 * registers, and the match here is exact, so the case has to be listed by hand.
 */
export const FOREIGN_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  SUBAGENT_TOOL_NAMES.WORKFLOW,
  "Workflow",
  "workflow",
]);

/** The fields of a registered tool this decision reads. */
export interface RegisteredToolInfo {
  name: string;
  description?: string;
  sourceInfo?: { source?: string };
}

export type WorkflowCollision =
  /** Nobody else is offering one. Carry on. */
  | { kind: "none" }
  /**
   * A foreign tool took our name, but the user pinned `workflowsEnabled: true`.
   * Nothing changes — pi has already dropped our registration — but it is worth
   * reporting, because pi resolved it silently.
   */
  | { kind: "report"; message: string }
  /**
   * Stand down for this session. `withdraw` is false in case 1, where ours
   * never reached the registry and there is nothing to take out of the active
   * set.
   */
  | { kind: "standDown"; message: string; withdraw: boolean };

/**
 * Decide, from the registered tools alone.
 *
 * `ownDescription` identifies our own registration: this extension does not
 * know its install path, and the description is the one field that is certainly
 * ours. `pinned` is an explicit `workflowsEnabled` — a default yields to
 * evidence, a choice does not.
 */
export function decideWorkflowCollision(input: {
  tools: readonly RegisteredToolInfo[];
  ownDescription: string;
  pinned: boolean;
}): WorkflowCollision {
  const foreign = input.tools.find(
    tool => FOREIGN_WORKFLOW_TOOL_NAMES.has(tool.name) && tool.description !== input.ownDescription,
  );
  if (foreign === undefined) return { kind: "none" };

  const source = foreign.sourceInfo?.source ?? "unknown source";
  const tookOurName = foreign.name === SUBAGENT_TOOL_NAMES.WORKFLOW;

  if (input.pinned) {
    if (!tookOurName) return { kind: "none" };
    return {
      kind: "report",
      message:
        `Another extension (${source}) already registers a "${SUBAGENT_TOOL_NAMES.WORKFLOW}" tool. ` +
        "Pi keeps the first registration, so this extension's workflow tool is not offered to the " +
        "model. Disable one of the two.",
    };
  }

  return {
    kind: "standDown",
    message:
      `Another extension (${source}) already provides a "${foreign.name}" tool, so this extension's ` +
      "workflows are disabled for this session to avoid offering the model two orchestrators. " +
      'Set `"workflowsEnabled": true` in .pi/subagents.json to keep both.',
    // Case 1: ours never reached the registry, so there is nothing to withdraw.
    withdraw: !tookOurName,
  };
}
