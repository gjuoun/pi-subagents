/**
 * deps.ts — what every `/agents` surface needs from the extension around it.
 *
 * The menu family was a thousand lines inside the entrypoint's factory body, reaching the
 * activation's state, the settings accessors it now owns, and three of the entrypoint's own
 * closures. This is that seam, stated once.
 *
 * The context half is a structural interface rather than an import of `ActivationContext`, for a
 * layout reason: `extension/` is inward-facing — only `index.ts` may import it — so a `ui/`
 * module cannot name the class. Declaring the slice that is used keeps the dependency pointing one
 * way and turns a renamed or re-typed accessor into a compile error at the one place the object is
 * handed over.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { ToolDescriptionMode } from "../../config/settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../../lib/types.js";
import type { AgentActivity } from "../../lib/ui/theme.js";
import type { ModelScope } from "../../model/model-scope.js";
import type { SubagentScheduler } from "../../schedule/schedule.js";
import type { WorkflowTask } from "../../workflow/run/task.js";

/** The slice of the activation context these surfaces read and write. */
export interface AgentsUiContext {
  /** The manager behind every row these menus list, inspect or spawn. */
  manager: AgentManager;
  /** Live per-agent activity, handed to the conversation viewer. */
  agentActivity: Map<string, AgentActivity>;
  /** The schedule store, for the `Scheduled jobs` entry. */
  scheduler: SubagentScheduler;
  /** Live workflow runs, counted on the `Workflows` entry. */
  workflowTasks: ReadonlyMap<string, WorkflowTask>;
  /** Whether a bad agent file is fatal on load — the one plain field these menus write. */
  strictAgentFiles: boolean;
  /** The `scopeModels` policy the Settings row reads and writes. */
  modelScope: ModelScope;

  // Settings, read live by the overlay and written by its rows.
  reportUsage: boolean;
  showCost: boolean;
  showModel: boolean;
  viewerMarkdown: ViewerMarkdownMode;
  widgetMode: WidgetMode;
  fleetViewEnabled: boolean;
  agentMentionMode: AgentMentionMode;
  defaultJoinMode: JoinMode;
  backgroundByDefault: boolean;
  schedulingEnabled: boolean;
  workflowsEnabled: boolean;
  workflowsPinned: boolean;
  jevEnabled: boolean;
  toolDescriptionMode: ToolDescriptionMode;

  // The six setters that do more than store the value: a repaint, the usage drain, or
  // latching the user's answer as their own.
  setReportUsage(b: boolean): void;
  setShowCost(b: boolean): void;
  setShowModel(b: boolean): void;
  setWidgetMode(m: WidgetMode): void;
  setFleetViewEnabled(b: boolean): void;
  setWorkflowsEnabled(b: boolean): void;
}

/** Everything the `/agents` surfaces need from the extension around them. */
export interface AgentsUiDeps {
  /** The extension API: the settings save emits on it, the generate wizard spawns through it. */
  pi: ExtensionAPI;
  /** The activation's state and settings accessors. */
  context: AgentsUiContext;
  /** Re-read the project/global agent dirs and re-register the merged set. */
  reloadCustomAgents(strict?: boolean): void;
  /** Flip the built-in defaults off/on and re-register — the wrapper around `setDefaultsDisabled`. */
  setDisableDefaultAgents(enabled: boolean): void;
}
