/**
 * manager-callbacks.ts — the policy the manager calls back into.
 *
 * Moved out of the entrypoint as-is: the lifecycle events, the persisted record entry, and the
 * route from a finished agent to either its group or its own nudge. It reaches the manager as a
 * constructor argument (src/bootstrap.ts), because this is policy and the manager is a handle.
 *
 * Everything it reads arrives as a slice of the handles or of the activation state, so the
 * callbacks stay testable without an activation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../lib/types.js";
import { type AgentActivity } from "../lib/ui/theme.js";
import { getLifetimeTotal, type LifetimeUsage, toReportedUsage } from "../lib/usage.js";
import { isTopLevelAgent, type OnAgentCompact, type OnAgentComplete, type OnAgentStart, type OnAgentUsage } from "./agent-manager.js";

/** The handles these callbacks read. */
export interface CallbackServices {
  /** Live per-agent activity, cleared when an agent is announced or consumed. */
  agentActivity: Map<string, AgentActivity>;
  /** The status row, refreshed as runs start and settle. */
  status: { markFinished(id: string): void; update(): void; ensureTimer(): void };
  /** The below-editor list, refreshed alongside it. */
  fleet: { onAgentFinished(id: string): void; update(): void; ensureTimer(): void };
  /** Spend accumulated for the parent session. */
  pendingUsage: { add(usage: LifetimeUsage): void };
  /** The group joiner: a finished agent is offered to its group before it is announced alone. */
  groupJoin: { onAgentComplete(record: AgentRecord): "pass" | "held" | "delivered" };
}

/** The activation state these callbacks read. */
export interface CallbackContext {
  /** Background ids spawned this turn: an agent inside its debounce window is not nudged yet. */
  currentBatchAgents: { id: string }[];
  /** The live session context, for the hasUI gate on the repaint. */
  currentCtx?: { hasUI?: boolean };
  /** Whether subagent spend is attached to tool results. */
  reportUsage: boolean;
}

export interface ManagerCallbacksDeps {
  pi: ExtensionAPI;
  services: CallbackServices;
  context: CallbackContext;
  /**
   * The completion policy's nudge — declared structurally, because agent/ may not import ui/,
   * and satisfied by the object src/ui/completion-nudge.ts builds.
   */
  notify: { sendIndividualNudge(record: AgentRecord): void };
}

export function createManagerCallbacks({ pi, services, context, notify }: ManagerCallbacksDeps) {
  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    // The whole run's spend as a pi `Usage` — pi's convention for handing spend
    // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
    // listener already expects them and anything pi adds to `Usage` arrives
    // without a change here. Omitted when nothing was spent, so "spent nothing"
    // and "never ran" stay distinguishable. Ungated by `showCost`: that setting
    // governs what a human is shown, not what the event carries.
    //
    // `tokens` above is the other convention, kept as it shipped: a flat view
    // model like pi's own `SessionStats`, carrying the DISPLAY total, which
    // excludes cacheRead (#38). The two answer different questions and neither
    // derives from the other.
    const usage = toReportedUsage(u);
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      usage,
    };
  }

  /**
   * The manager's completion policy: the lifecycle events, the record entry, and the route
   * through group join or an individual nudge. Injected into the manager that
   * src/bootstrap.ts builds.
   */
  const onAgentComplete: OnAgentComplete = (record) => {
    // Owned children — nested, or a workflow's — report only through their
    // owner: the parent's scoped tools, or the workflow's card, notification
    // and dialog. Keep them out of top-level lifecycle, transcript,
    // notification, and UI channels.
    if (!isTopLevelAgent(record)) return;

    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      services.agentActivity.delete(record.id);
      services.status.markFinished(record.id);
      services.fleet.onAgentFinished(record.id);
      services.status.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (context.currentBatchAgents.some(a => a.id === record.id)) {
      services.status.update();
      return;
    }

    const result = services.groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      notify.sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    services.status.update();
  };

  const onAgentStart: OnAgentStart = (record) => {
    if (!isTopLevelAgent(record)) return;
    // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
    // and scheduler spawns enter through the manager directly.
    if (context.currentCtx?.hasUI) {
      services.status.ensureTimer();
      services.status.update();
      services.fleet.ensureTimer();
      services.fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  };

  const onAgentCompact: OnAgentCompact = (record, info) => {
    if (!isTopLevelAgent(record)) return;
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  };

  const onAgentUsage: OnAgentUsage = (_record, usage) => {
    // Every assistant message from every agent — nested included, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (context.reportUsage) services.pendingUsage.add(usage);
  };

  return { onAgentComplete, onAgentStart, onAgentCompact, onAgentUsage };
}
