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
import type { RpcHandle } from "../agent/rpc.js";
import type { ToolDescriptionMode } from "../config/settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../lib/types.js";

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
    if (!b) this.repaint.pendingUsage.drain();
  }

  /** Show `~$X` next to token counts in the subagent surfaces. */
  showCost = false;
  setShowCost(b: boolean): void { this.showCost = b; this.repaint.status.update(); this.repaint.fleet.update(); }

  /** Name the model and thinking level on the widget's running rows. */
  showModel = false;
  setShowModel(b: boolean): void { this.showModel = b; this.repaint.status.update(); }

  /** How much of the conversation viewer renders as Markdown. */
  viewerMarkdown: ViewerMarkdownMode = "all";

  /**
   * What the above-editor widget shows: "all" = every agent; "background" = hide foreground
   * (they already render inline as the Agent tool result, so showing them here too is a
   * duplicate, #118); "off" = hide the widget entirely. Read live at render time.
   */
  widgetMode: WidgetMode = "background";
  setWidgetMode(m: WidgetMode): void { this.widgetMode = m; this.repaint.status.update(); }

  /** Whether the below-editor FleetView is drawn at all. */
  fleetViewEnabled = true;
  setFleetViewEnabled(b: boolean): void { this.fleetViewEnabled = b; this.repaint.fleet.setEnabled(b); }

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

  /**
   * Master switch for `schedule` params and the schedule store. Read once at extension init,
   * before tool registration: a runtime toggle takes effect at once for the menu entry and the
   * execute-time addJob path, but the param schema itself only changes on the next extension
   * load (the next pi session).
   */
  schedulingEnabled = true;

  /**
   * Master switch for the `jev` agent-selector tool. Default OFF: the tool costs an API call per
   * use, so it is opt-in. Read once at extension init, before tool registration, so the tool's
   * presence follows the persisted setting and a runtime toggle lands on the next pi session.
   */
  jevEnabled = false;

  /**
   * Master switch for the `SubagentWorkflow` tool and everything behind it. Off means the tool
   * is never registered: the model is not told the feature exists (zero context cost) and has
   * nothing to call, and the `/agents → Workflows` view and `--subagents-workflow-file` are
   * refused too — no second door into the same machinery.
   */
  workflowsEnabled = true;
  /**
   * Whether `workflowsEnabled` is the user's answer (a boolean in subagents.json, or the
   * settings toggle) rather than this default. `resolveWorkflowCollisions` checks it before
   * yielding to another extension's workflow tool: a default may be overridden by what else is
   * loaded, an explicit choice may not.
   */
  workflowsPinned = false;
  setWorkflowsEnabled(b: boolean): void {
    this.workflowsEnabled = b;
    this.workflowsPinned = true;
  }

  /**
   * Which Agent tool description is registered: "full" (default) keeps the rich Claude
   * Code-style description, "compact" swaps in a ~75% smaller one for small or local models
   * (#91). Read once at tool registration — flipping it applies on the next pi session.
   */
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

  /**
   * Background agent ids spawned in the current turn, for smart grouping. Collected through a
   * debounced timer: each new agent resets the window, so parallel tool calls — which the
   * framework may dispatch across several microtasks — land in the same batch.
   */
  currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  /** Debounce timer that closes the current batch. */
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic id for the groups those batches become. */
  batchCounter = 0;

  /**
   * The surfaces a settings write has to repaint, and the pool a disabled `reportUsage` has to
   * drain. Attached once at activation, from the handles src/bootstrap.ts builds. This is the
   * only handle reference this class keeps, and it is deliberately the narrowest one that
   * works: a setter that stores a value without repainting is exactly the bug those six exist
   * to prevent, so the repaint cannot be pushed out to the callers.
   */
  repaint!: {
    status: { update(): void };
    fleet: { update(): void; setEnabled(enabled: boolean): void };
    pendingUsage: { drain(): void };
  };

  pendingNudges!: Map<string, ReturnType<typeof setTimeout>>;
}
