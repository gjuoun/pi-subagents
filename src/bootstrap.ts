/**
 * bootstrap.ts — the activation's shared handles: built once, in order, and frozen.
 *
 * Why this file exists. These ten objects are the activation's cross-cutting singletons:
 * every domain reads them, no domain owns them. They used to be constructed at ten points
 * spread over a thousand lines of the entrypoint, interleaved with the logic that reads
 * them, so the construction order that actually matters — the status row and the fleet
 * list take the manager, the manager's own callbacks read the status row — was invisible.
 *
 * The shape is the Hono starter template's bootstrap(): one place builds the shared
 * handles, everything they need arrives as an argument rather than being reached for, and
 * the result is frozen so a later module cannot stash itself on it. What stays injectable
 * is the completion policy: the manager's callbacks and the group joiner's delivery hook
 * are the nudge/notification logic, which belongs to the wiring layer, so it is passed in
 * the same way a database handle is passed to a route factory.
 *
 * The settings the render surfaces show are read through getters, not captured: the
 * settings applier rewrites them mid-session and the surfaces follow.
 *
 * Layering: this file is part of the wiring layer (see test/layout-fence.test.ts), which is
 * what lets it import ui/. It deliberately does not import extension/ — the activation's
 * state is handed to it as a slice, so that directory stays reachable from the entrypoint
 * alone.
 */

import {
  AgentManager,
  isTopLevelAgent,
  type OnAgentCompact,
  type OnAgentComplete,
  type OnAgentStart,
  type OnAgentUsage,
} from "./agent/agent-manager.js";
import { type DeliveryCallback, GroupJoinManager } from "./agent/group-join.js";
import type { ViewerMarkdownMode } from "./lib/types.js";
import type { AgentActivity } from "./lib/ui/theme.js";
import { PendingUsagePool } from "./lib/usage.js";
import { ModelScope } from "./model/model-scope.js";
import { SubagentScheduler } from "./schedule/schedule.js";
import { AgentStatusBar } from "./ui/agent-status-row.js";
import { FleetList } from "./ui/fleet-list.js";
import type { WorkflowTask } from "./workflow/run/task.js";

/** How long a joined group waits for its members before reporting as partial. */
const GROUP_JOIN_TIMEOUT_MS = 30_000;

/**
 * The completion policy the manager and the group joiner call back into. Supplied by the
 * wiring layer rather than defined here: it is nudge/notification behaviour, not
 * construction.
 */
export interface CompletionHooks {
  onAgentComplete?: OnAgentComplete;
  onAgentStart?: OnAgentStart;
  onAgentCompact?: OnAgentCompact;
  onAgentUsage?: OnAgentUsage;
  /** Called once a joined group of agents has settled (or timed out as partial). */
  onGroupComplete: DeliveryCallback;
}

export interface ServicesArgs {
  /** Live read of the showCost setting, for the surfaces that show a cost. */
  showCost(): boolean;
  /** Live read of the viewerMarkdown setting, for an overlay opened from the fleet list. */
  viewerMarkdown(): ViewerMarkdownMode;
  hooks: CompletionHooks;
}

/**
 * Build the shared handles. Order is load-bearing and stated here once: the manager is
 * constructed before the two render surfaces that take it, and the group joiner receives
 * its delivery hook rather than reaching for one.
 */
export function createServices(args: ServicesArgs) {
  const { showCost, viewerMarkdown, hooks } = args;

  // Collections with no policy in them — nothing below reads these at construction time.
  const agentActivity = new Map<string, AgentActivity>();
  const pendingUsage = new PendingUsagePool();
  /**
   * The one `scopeModels` policy for this activation — written by the settings applier and the
   * `/agents` toggle, read by every spawn path (Agent tool, nested tools, workflow host, RPC).
   * It has to be one object: the allowlist cache is keyed by working directory, which only an
   * instance can hold.
   */
  const modelScope = new ModelScope();
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Live workflow runs, by task id. The tool returns before the run finishes, so its result
   * card looks the task up here on every render rather than freezing a snapshot into
   * `details` — that is what makes the inline card follow a background run.
   */
  const workflowTasks = new Map<string, WorkflowTask>();

  const manager = new AgentManager(
    hooks.onAgentComplete,
    undefined,
    hooks.onAgentStart,
    hooks.onAgentCompact,
    hooks.onAgentUsage,
  );
  // Nested delegation tools are built per child in agent-runner.ts, where the manager is
  // the only handle on this activation — so the scope rides with it.
  manager.modelScope = modelScope;

  const groupJoin = new GroupJoinManager(hooks.onGroupComplete, GROUP_JOIN_TIMEOUT_MS);

  const scheduler = new SubagentScheduler();

  const status = new AgentStatusBar({
    // listAgents() is newest-first, so mapping straight through put the agent launched FIRST
    // on the far RIGHT of the row. Earliest launch first, the same order the FleetView rows use.
    listAgents: () => manager.listAgents()
      .filter(isTopLevelAgent)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((record) => ({ id: record.id, type: record.type, status: record.status })),
  });

  const fleet = new FleetList(manager, agentActivity, showCost, viewerMarkdown);

  return Object.freeze({
    manager,
    groupJoin,
    status,
    fleet,
    scheduler,
    agentActivity,
    pendingUsage,
    modelScope,
    pendingNudges,
    workflowTasks,
  });
}

/**
 * Derived, never hand-written: adding a handle above propagates to every consumer with no
 * second edit.
 */
export type Services = ReturnType<typeof createServices>;
