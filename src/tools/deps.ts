/**
 * deps.ts — what the four tool definitions need from the extension around them.
 *
 * The tools were 1,300 lines inside the entrypoint's factory body, reaching the activation's
 * state and five of the entrypoint's own closures. This is that seam, stated once.
 *
 * {@link ToolsContext} is a structural interface rather than an import of `ActivationContext`,
 * for a layout reason: `extension/` is inward-facing — only `index.ts` may import it — so a
 * `tools/` module cannot name the class. Declaring the slice that is used keeps the dependency
 * pointing one way and turns a renamed or re-typed accessor into a compile error at the one place
 * the object is handed over.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent/agent-manager.js";
import type { SettingsSurface } from "../config/settings.js";
import type { AgentRecord, JoinMode } from "../lib/types.js";
import type { AgentActivity } from "../lib/ui/theme.js";
import type { PendingUsagePool } from "../lib/usage.js";
import type { ModelScope } from "../model/model-scope.js";
import type { SubagentScheduler } from "../schedule/schedule.js";
import type { AgentStatusBar } from "../ui/agent-status-row.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/run/task.js";

/**
 * The slice of the activation context the tool layer reads and writes. The settings half is
 * taken from SettingsSurface rather than restated: that type is what the FIELDS table in
 * config/settings.ts is written against, so a setting and its writer stay in step in one place
 * instead of three. The two members below it are the batching state only this layer touches.
 */
export interface ToolsContext
  extends Pick<
    SettingsSurface,
    | "showCost"
    | "defaultJoinMode"
    | "schedulingEnabled"
    | "jevEnabled"
    | "backgroundByDefault"
    | "reportUsage"
    | "toolDescriptionMode"
  > {
  /** Background ids spawned in this turn, for smart-join grouping. */
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  /** The debounce timer that closes the current batch. */
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The live handles the tool layer reads, declared structurally rather than imported: `Services`
 * is composed in the wiring layer (src/bootstrap.ts), which a `tools/` module may not reach for.
 * Every member is satisfied by the frozen object that layer builds, so a renamed or re-typed
 * handle is a compile error at the one place the two are put together — the deps literal in
 * src/index.ts.
 */
export interface ToolsServices {
  /** The manager every spawn, resume, steer and abort goes through. */
  manager: AgentManager;
  /** Live per-agent activity, read by the workflow host's callbacks. */
  agentActivity: Map<string, AgentActivity>;
  /** The status row, refreshed when a run starts or settles. */
  status: AgentStatusBar;
  /** The below-editor list, refreshed alongside it. */
  fleet: FleetList;
  /** The schedule store, for the Agent tool's `schedule` param. */
  scheduler: SubagentScheduler;
  /** Live workflow runs, by task id. */
  workflowTasks: Map<string, WorkflowTask>;
  /** Spend accumulated since the parent was last told about it. */
  pendingUsage: PendingUsagePool;
  /** The `scopeModels` policy every spawn from this tool passes through. */
  modelScope: ModelScope;
}

/** Everything the tool definitions need from the extension around them. */
export interface ToolsDeps {
  /** The extension API: tools are registered on it and events are emitted from it. */
  pi: ExtensionAPI;
  /** The live handles: the manager, the surfaces, the pools. Built by src/bootstrap.ts. */
  services: ToolsServices;
  /** The activation's state and settings accessors. */
  context: ToolsContext;
  /** Re-read the project/global agent dirs and re-register the merged set. */
  reloadCustomAgents(strict?: boolean): void;
  /** Close the current smart-join batch and register it as a group. */
  finalizeBatch(): void;
  /** Detached resume for an existing agent — the Agent tool's resume branch. */
  startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined>;
  /** Resolve an id or `@handle` to a record, the way the tools address agents. */
  resolveAgentRef(ref: string): AgentRecord | undefined;
  /** Drop a held completion notification, so a consumed result is not announced twice. */
  cancelNudge(key: string): void;
  /** Hold a notification briefly so a result fetched immediately can still suppress it. */
  scheduleNudge(key: string, send: () => void, delay?: number): void;
  /** How often a `wait: true` poll re-checks a queued agent, kept under the nudge hold. */
  queueWaitPollMs: number;
}

