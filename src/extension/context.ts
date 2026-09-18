/**
 * context.ts — the activation-scope state one extension instance owns.
 *
 * This is the cell the entrypoint's clusters were already reaching through. `index.ts` declares
 * ~26 `let`/`const` bindings in its factory body and 48 clusters read them: `manager` from 15,
 * `widget`/`fleet`/`agentActivity` from 11, and `showCost` is declared hundreds of lines below
 * the renderer that reads it. That coupling is why the entrypoint could not be split by moving
 * code — a `let` cannot be handed to another module.
 *
 * So the cells live here instead, in one object created at activation. Nothing about them
 * changed: same values, same defaults, same read and write sites, same order of initialization.
 * The one thing that did change is that they are now reachable from outside `index.ts`, which is
 * what the extractions that follow need.
 *
 * The settings accessors live here too. They were 26 free functions in the factory body, one pair
 * per cell; a cluster lifted out of `index.ts` would otherwise have to be handed all of them as a
 * callback bag, which is the coupling this object exists to remove. The setter-shaped ones are
 * allowed to repaint (`setShowCost` also calls `widget.update()`) because the surfaces they
 * repaint belong to the same activation and are fields right here. Every mutation path funnels
 * through these, so there is exactly one place a setting changes.
 *
 * Layering: not one of the six domains. It is the entrypoint's own state, so `layout-check`
 * treats it like `index` — unconstrained in what it may import, and never imported by a domain.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent/agent-manager.js";
import type { GroupJoinManager } from "../agent/group-join.js";
import type { RpcHandle } from "../agent/rpc.js";
import type { ToolDescriptionMode } from "../config/settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../lib/types.js";
import type { AgentActivity } from "../lib/ui/theme.js";
import type { PendingUsagePool } from "../lib/usage.js";
import type { SubagentScheduler } from "../schedule/schedule.js";
import type { AgentStatusBar } from "../ui/agent-status-bar.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/run/task.js";

export class ActivationContext {
  // ---- Settings-driven state. Written by the settings appliers, read by the surfaces. ----

  /** Whether a bad custom agent file is fatal on load. Loaded before settings apply. */
  strictAgentFiles = false;

  /** Attach subagent spend to tool results, so the parent session counts it. */
  reportUsage = false;
  isReportUsageEnabled(): boolean { return this.reportUsage; }
  setReportUsage(b: boolean): void {
    this.reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) this.pendingUsage.drain();
  }

  /** Show `~$X` next to token counts in the subagent surfaces. */
  showCost = false;
  isShowCostEnabled(): boolean { return this.showCost; }
  setShowCost(b: boolean): void { this.showCost = b; this.status.update(); this.fleet.update(); }

  /** Name the model and thinking level on the widget's running rows. */
  showModel = false;
  isShowModelEnabled(): boolean { return this.showModel; }
  setShowModel(b: boolean): void { this.showModel = b; this.status.update(); }

  /** How much of the conversation viewer renders as Markdown. */
  viewerMarkdown: ViewerMarkdownMode = "all";
  getViewerMarkdown(): ViewerMarkdownMode { return this.viewerMarkdown; }
  setViewerMarkdown(mode: ViewerMarkdownMode): void { this.viewerMarkdown = mode; }

  /** What the above-editor widget shows. */
  widgetMode: WidgetMode = "background";
  getWidgetMode(): WidgetMode { return this.widgetMode; }
  setWidgetMode(m: WidgetMode): void { this.widgetMode = m; this.status.update(); }

  /** Whether the below-editor FleetView is drawn at all. */
  fleetViewEnabled = true;
  isFleetViewEnabled(): boolean { return this.fleetViewEnabled; }
  setFleetViewEnabled(b: boolean): void { this.fleetViewEnabled = b; this.fleet.setEnabled(b); }

  /** How `@handle` mentions resolve: model-decided, always clone, or off. */
  agentMentionMode: AgentMentionMode = "model";
  getAgentMentionMode(): AgentMentionMode { return this.agentMentionMode; }
  setAgentMentionMode(mode: AgentMentionMode): void { this.agentMentionMode = mode; }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  isAgentMentionsEnabled(): boolean { return this.agentMentionMode !== "off"; }

  /** Grouping behaviour for a fan-out that does not ask for one. */
  defaultJoinMode: JoinMode = "smart";
  getDefaultJoinMode(): JoinMode { return this.defaultJoinMode; }
  setDefaultJoinMode(mode: JoinMode): void { this.defaultJoinMode = mode; }

  /** Whether a top-level spawn without `run_in_background` detaches. */
  backgroundByDefault = true;
  getBackgroundByDefault(): boolean { return this.backgroundByDefault; }
  setBackgroundByDefault(b: boolean): void { this.backgroundByDefault = b; }

  /** Master switch for `schedule` params and the schedule store. */
  schedulingEnabled = true;
  isSchedulingEnabled(): boolean { return this.schedulingEnabled; }
  setSchedulingEnabled(b: boolean): void { this.schedulingEnabled = b; }

  /** Master switch for the `jev` agent-selector tool. Default OFF — API cost per call. */
  jevEnabled = false;
  isJevEnabled(): boolean { return this.jevEnabled; }
  setJevEnabled(b: boolean): void { this.jevEnabled = b; }

  /** Master switch for the `SubagentWorkflow` tool and everything behind it. */
  workflowsEnabled = true;
  /** Whether `workflowsEnabled` came from the user rather than from its default. */
  workflowsPinned = false;
  isWorkflowsEnabled(): boolean { return this.workflowsEnabled; }
  isWorkflowsPinned(): boolean { return this.workflowsPinned; }
  setWorkflowsEnabled(b: boolean): void {
    this.workflowsEnabled = b;
    this.workflowsPinned = true;
  }

  /** Which Agent tool description is registered. */
  toolDescriptionMode: ToolDescriptionMode = "full";
  getToolDescriptionMode(): ToolDescriptionMode { return this.toolDescriptionMode; }
  setToolDescriptionMode(mode: ToolDescriptionMode): void { this.toolDescriptionMode = mode; }

  // ---- Activation lifecycle ----

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

  // ---- Batch tracking for smart join mode ----

  /** Background agent ids spawned in the current turn. */
  currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  /** Debounce timer that closes the current batch. */
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic id for the groups those batches become. */
  batchCounter = 0;

  // ---- Live handles, assigned once during activation ----

  manager!: AgentManager;
  groupJoin!: GroupJoinManager;
  agentActivity!: Map<string, AgentActivity>;
  status!: AgentStatusBar;
  fleet!: FleetList;
  scheduler!: SubagentScheduler;
  workflowTasks!: Map<string, WorkflowTask>;
  pendingUsage!: PendingUsagePool;
  pendingNudges!: Map<string, ReturnType<typeof setTimeout>>;
}
