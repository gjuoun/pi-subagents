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
import type { SettingsSurface } from "../../config/settings.js";
import type { AgentActivity } from "../../lib/ui/theme.js";
import type { ModelScope } from "../../model/model-scope.js";
import type { SubagentScheduler } from "../../schedule/schedule.js";
import type { WorkflowTask } from "../../workflow/run/task.js";

/**
 * The slice of the activation context these surfaces read and write: the settings the applier
 * owns, taken from SettingsSurface rather than restated (that type is what the FIELDS table in
 * config/settings.ts is written against, so a setting and its writer stay in step in one place),
 * plus the one field the Workflows row reads on its own.
 */
export interface AgentsUiContext extends SettingsSurface {
  /**
   * Whether `workflowsEnabled` is the user's own answer rather than the default. The Workflows
   * row shows the difference: a default may yield to another extension's workflow tool, an
   * explicit choice may not.
   */
  workflowsPinned: boolean;
}

/**
 * The live handles these surfaces read, declared structurally rather than imported: `Services` is
 * composed in the wiring layer (src/bootstrap.ts), which a `ui/` module may not reach for. Every
 * member is satisfied by the frozen object that layer builds, so a renamed or re-typed handle is a
 * compile error at the one place the two are put together — the deps literal in src/index.ts.
 */
export interface AgentsUiServices {
  /** The manager behind every row these menus list, inspect or spawn. */
  manager: AgentManager;
  /** Live per-agent activity, handed to the conversation viewer. */
  agentActivity: Map<string, AgentActivity>;
  /** The schedule store, for the `Scheduled jobs` entry. */
  scheduler: SubagentScheduler;
  /** Live workflow runs, counted on the `Workflows` entry. */
  workflowTasks: ReadonlyMap<string, WorkflowTask>;
  /** The `scopeModels` policy the Settings row reads and writes. */
  modelScope: ModelScope;
}

/** Everything the `/agents` surfaces need from the extension around them. */
export interface AgentsUiDeps {
  /** The extension API: the settings save emits on it, the generate wizard spawns through it. */
  pi: ExtensionAPI;
  /** The live handles: the manager, the surfaces, the schedule store. Built by src/bootstrap.ts. */
  services: AgentsUiServices;
  /** The activation's state and settings accessors. */
  context: AgentsUiContext;
  /** Re-read the project/global agent dirs and re-register the merged set. */
  reloadCustomAgents(strict?: boolean): void;
  /** Flip the built-in defaults off/on and re-register — the wrapper around `setDefaultsDisabled`. */
  setDisableDefaultAgents(enabled: boolean): void;
}
