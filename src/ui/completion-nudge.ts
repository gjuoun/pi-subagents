/**
 * completion-nudge.ts — when a finished agent becomes a message, and how it is drawn.
 *
 * Moved out of the entrypoint: the hold that lets get_subagent_result cancel a notification
 * before it is sent, the single-agent and group deliveries, and the renderer that draws both.
 * The wording lives in notifications.ts, which stays pure — this module is the policy and the
 * timing around it, and it is the only place a completion becomes a pi.sendMessage call.
 *
 * It registers rather than being called: constructing the policy installs the message renderer,
 * the way a route factory registers its routes, so the surface this module owns is stated once.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { DeliveryCallback } from "../agent/group-join.js";
import { AgentRecord, JoinMode } from "../lib/types.js";
import { formatCost, formatMs, formatTokens, formatTurns } from "../lib/ui/format.js";
import type { AgentActivity } from "../lib/ui/theme.js";
import type { NotificationDetails } from "./notifications.js";
import { buildNotificationDetails, formatTaskNotification } from "./notifications.js";

/** The handles this policy reads. Structural, like every slice: the wiring layer owns the objects. */
export interface NudgeServices {
  /** Live per-agent activity, cleared as each agent is announced. */
  agentActivity: Map<string, AgentActivity>;
  /** The status row: the finished mark, then the repaint. */
  status: { markFinished(id: string): void; update(): void };
  /** The below-editor list, told which agent finished. */
  fleet: { onAgentFinished(id: string): void };
  /** Notifications held briefly, so a result fetched in time can cancel them. */
  pendingNudges: Map<string, ReturnType<typeof setTimeout>>;
  /** The records behind an id — the batch window closes over what is on them. */
  manager: { getRecord(id: string): AgentRecord | undefined };
  /** Where a batch that reached 2+ smart-mode agents is registered. */
  groupJoin: {
    registerGroup(groupId: string, ids: string[]): void;
    onAgentComplete(record: AgentRecord): void;
  };
}

/**
 * The debounce window a spawn batch accumulates on.
 *
 * Mutable and shared with the callers that push into it — the Agent tool and the mention paths —
 * which is why the activation's own object arrives rather than a copy.
 */
export interface BatchWindow {
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  batchCounter: number;
}

export interface CompletionNudgeDeps {
  pi: ExtensionAPI;
  services: NudgeServices;
  /** Live read of the showCost setting: the figure shows only when the user asked for it. */
  showCost(): boolean;
  batch: BatchWindow;
}

export function createCompletionNudge({ pi, services, showCost, batch }: CompletionNudgeDeps) {
  const NUDGE_HOLD_MS = 200;
  // A queued result wait must observe completion before its held notification
  // can fire, so successful waits can still suppress that redundant nudge.
  const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    services.pendingNudges.set(key, setTimeout(() => {
      services.pendingNudges.delete(key);
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = services.pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      services.pendingNudges.delete(key);
    }
  }

  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500, showCost());
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, services.agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    services.agentActivity.delete(record.id);
    services.status.markFinished(record.id);
    services.fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    services.status.update();
  }

  /**
   * The group-join delivery policy: what happens when a joined group of agents settles.
   * Injected into the joiner that src/bootstrap.ts builds.
   */
  const onGroupComplete: DeliveryCallback = (records, partial) => {
      for (const r of records) { services.agentActivity.delete(r.id); services.status.markFinished(r.id); services.fleet.onAgentFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { services.status.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300, showCost())).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, services.agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, services.agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      services.status.update();
  };

  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (showCost()) {
          const costText = formatCost(d.totalCost ?? 0);
          if (costText) parts.push(costText);
        }
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: output file link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      const rendered = all.map(renderOne);
      // A group of agents lands as one notification, and the number a user wants
      // from it is what the batch cost — not four figures to add up by hand.
      // Derived from the per-agent details rather than carried alongside them:
      // one source, so the total can never disagree with the rows above it.
      if (showCost() && all.length > 1) {
        const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
        if (total) {
          const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
          rendered.unshift(theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`));
        }
      }
      return new Text(rendered.join("\n"), 0, 0);
    }
  );

  /**
   * Close the batch window.
   *
   * 2+ smart-mode agents arriving together are announced as one group rather than N nudges; an
   * agent that completed while the window was open had its delivery deferred, so it is fed into
   * the group retroactively. Anything else is announced individually.
   */
  function finalizeBatch() {
    batch.batchFinalizeTimer = undefined;
    const batchAgents = [...batch.currentBatchAgents];
    batch.currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batch.batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      services.groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = services.manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          services.groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = services.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  return { scheduleNudge, cancelNudge, sendIndividualNudge, finalizeBatch, onGroupComplete, queueWaitPollMs: QUEUE_WAIT_POLL_MS };
}

/** What the wiring layer keeps a handle on. */
export type CompletionNudge = ReturnType<typeof createCompletionNudge>;
