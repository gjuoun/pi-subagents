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
 * Fields are plain and public on purpose. The setter-shaped helpers that repaint
 * (`setShowCost` also calls `widget.update()`) stay in `index.ts`, because they are wiring —
 * this object owns state, not side effects.
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
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/run/task.js";

export class ActivationContext {
  // ---- Settings-driven state. Written by the settings appliers, read by the surfaces. ----

  /** Whether a bad custom agent file is fatal on load. Loaded before settings apply. */
  strictAgentFiles = false;
  /** Attach subagent spend to tool results, so the parent session counts it. */
  reportUsage = false;
  /** Show `~$X` next to token counts in the subagent surfaces. */
  showCost = false;
  /** Name the model and thinking level on the widget's running rows. */
  showModel = false;
  /** How much of the conversation viewer renders as Markdown. */
  viewerMarkdown: ViewerMarkdownMode = "all";
  /** What the above-editor widget shows. */
  widgetMode: WidgetMode = "background";
  /** Whether the below-editor FleetView is drawn at all. */
  fleetViewEnabled = true;
  /** How `@handle` mentions resolve: model-decided, always clone, or off. */
  agentMentionMode: AgentMentionMode = "model";
  /** Grouping behaviour for a fan-out that does not ask for one. */
  defaultJoinMode: JoinMode = "smart";
  /** Whether a top-level spawn without `run_in_background` detaches. */
  backgroundByDefault = true;
  /** Master switch for `schedule` params and the schedule store. */
  schedulingEnabled = true;
  /** Master switch for the `SubagentWorkflow` tool and everything behind it. */
  workflowsEnabled = true;
  /** Whether `workflowsEnabled` came from the user rather than from its default. */
  workflowsPinned = false;
  /** Which Agent tool description is registered. */
  toolDescriptionMode: ToolDescriptionMode = "full";

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
  widget!: AgentWidget;
  fleet!: FleetList;
  scheduler!: SubagentScheduler;
  workflowTasks!: Map<string, WorkflowTask>;
  pendingUsage!: PendingUsagePool;
  pendingNudges!: Map<string, ReturnType<typeof setTimeout>>;
}
