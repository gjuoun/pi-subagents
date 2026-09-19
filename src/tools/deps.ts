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
import type { ToolDescriptionMode } from "../config/settings.js";
import type { AgentRecord, JoinMode } from "../lib/types.js";
import type { AgentActivity } from "../lib/ui/theme.js";
import type { PendingUsagePool } from "../lib/usage.js";
import type { ModelScope } from "../model/model-scope.js";
import type { SubagentScheduler } from "../schedule/schedule.js";
import type { AgentStatusBar } from "../ui/agent-status-bar.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/run/task.js";

/** The slice of the activation context the tool layer reads and writes. */
export interface ToolsContext {
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
  /** Show `~$X` beside token counts — read when a tool result is rendered. */
  showCost: boolean;
  /** Join mode for a fan-out that did not ask for one. */
  defaultJoinMode: JoinMode;
  /** Background ids spawned in this turn, for smart-join grouping. */
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  /** The debounce timer that closes the current batch. */
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the schedule param is offered. */
  schedulingEnabled: boolean;
  /** Whether the toggleable `jev` agent-selector tool is registered. */
  jevEnabled: boolean;
  /** Whether an unqualified top-level spawn detaches. */
  backgroundByDefault: boolean;
  /** Attach subagent spend to tool results, so the parent session counts it. */
  reportUsage: boolean;
  /** Spend accumulated since the parent was last told about it. */
  pendingUsage: PendingUsagePool;
  /** Which Agent tool description is registered. */
  toolDescriptionMode: ToolDescriptionMode;
  /** The `scopeModels` policy every spawn from this tool passes through. */
  modelScope: ModelScope;
}

/** Everything the tool definitions need from the extension around them. */
export interface ToolsDeps {
  /** The extension API: tools are registered on it and events are emitted from it. */
  pi: ExtensionAPI;
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

