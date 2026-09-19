/**
 * context.ts — the activation-scope state one extension instance owns.
 *
 * The entrypoint's own state lives here rather than in `index.ts`'s factory body so it is
 * reachable from outside the entrypoint: a `let` cannot be handed to another module, which
 * is what blocked splitting the entrypoint by moving code. Same values, same defaults, same
 * read and write sites, same initialization order.
 *
 * The settings live here as plain public fields, so a cluster lifted out of `index.ts`
 * reads and writes them directly. Only the six setters whose assignment does something
 * beyond storing the value survive as methods — a repaint (`setShowCost`, `setShowModel`,
 * `setWidgetMode`, `setFleetViewEnabled`), draining the usage pool (`setReportUsage`), and
 * latching the user's own answer (`setWorkflowsEnabled`). Every mutation path still funnels
 * through one of those or through a field write.
 *
 * Layering: not one of the six domains. It is the entrypoint's own state, so `layout-check`
 * treats it like `index` — unconstrained in what it may import, and never imported by a
 * domain.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent/agent-manager.js";
import type { GroupJoinManager } from "../agent/group-join.js";
import type { RpcHandle } from "../agent/rpc.js";
import type { ToolDescriptionMode } from "../config/settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../lib/types.js";
import type { AgentActivity } from "../lib/ui/theme.js";
import type { PendingUsagePool } from "../lib/usage.js";
import type { ModelScope } from "../model/model-scope.js";
import type { SubagentScheduler } from "../schedule/schedule.js";
import type { AgentStatusBar } from "../ui/agent-status-bar.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/run/task.js";

export class ActivationContext {
  /** Whether a bad custom agent file is fatal on load. Loaded before settings apply. */
  strictAgentFiles = false;

  /** Attach subagent spend to tool results, so the parent session counts it. */
  reportUsage = false;
  setReportUsage(b: boolean): void {
    this.reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) this.pendingUsage.drain();
  }

  /** Show `~$X` next to token counts in the subagent surfaces. */
  showCost = false;
  setShowCost(b: boolean): void { this.showCost = b; this.status.update(); this.fleet.update(); }

  /** Name the model and thinking level on the widget's running rows. */
  showModel = false;
  setShowModel(b: boolean): void { this.showModel = b; this.status.update(); }

  /** How much of the conversation viewer renders as Markdown. */
  viewerMarkdown: ViewerMarkdownMode = "all";

  /** What the above-editor widget shows. */
  widgetMode: WidgetMode = "background";
  setWidgetMode(m: WidgetMode): void { this.widgetMode = m; this.status.update(); }

  /** Whether the below-editor FleetView is drawn at all. */
  fleetViewEnabled = true;
  setFleetViewEnabled(b: boolean): void { this.fleetViewEnabled = b; this.fleet.setEnabled(b); }

  /** How `@handle` mentions resolve: model-decided, always clone, or off. */
  agentMentionMode: AgentMentionMode = "model";
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  isAgentMentionsEnabled(): boolean { return this.agentMentionMode !== "off"; }

  /** Grouping behaviour for a fan-out that does not ask for one. */
  defaultJoinMode: JoinMode = "smart";

  /** Whether a top-level spawn without `run_in_background` detaches. */
  backgroundByDefault = true;

  /** Master switch for `schedule` params and the schedule store. */
  schedulingEnabled = true;

  /** Master switch for the `jev` agent-selector tool. Default OFF — API cost per call. */
  jevEnabled = false;

  /** Master switch for the `SubagentWorkflow` tool and everything behind it. */
  workflowsEnabled = true;
  /** Whether `workflowsEnabled` came from the user rather than from its default. */
  workflowsPinned = false;
  setWorkflowsEnabled(b: boolean): void {
    this.workflowsEnabled = b;
    this.workflowsPinned = true;
  }

  /** Which Agent tool description is registered. */
  toolDescriptionMode: ToolDescriptionMode = "full";

  /** The live session context, rebound on every `session_start`. */
  currentCtx: ExtensionContext | undefined;
  /** RPC subscriptions for this activation, torn down on shutdown. */
  rpcHandle: RpcHandle | undefined;
  /** Whether the `@`-mention provider has been installed for this activation. */
  mentionProviderRegistered = false;
  /** Whether the tool-collision stand-down has already run this session. */
  collisionsChecked = false;
  /** Whether the `--subagents-workflow-file` flag has already been honoured. */
  workflowFlagHandled = false;

  /** Background agent ids spawned in the current turn. */
  currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  /** Debounce timer that closes the current batch. */
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic id for the groups those batches become. */
  batchCounter = 0;

  manager!: AgentManager;
  groupJoin!: GroupJoinManager;
  agentActivity!: Map<string, AgentActivity>;
  status!: AgentStatusBar;
  fleet!: FleetList;
  scheduler!: SubagentScheduler;
  workflowTasks!: Map<string, WorkflowTask>;
  pendingUsage!: PendingUsagePool;
  /**
   * The one `scopeModels` policy for this activation — written by the settings
   * applier and the `/agents` toggle, read by every spawn path (Agent tool,
   * nested tools, workflow host, RPC). It has to be one object: the allowlist
   * cache is keyed by working directory, which only an instance can hold.
   */
  modelScope!: ModelScope;
  pendingNudges!: Map<string, ReturnType<typeof setTimeout>>;
}
