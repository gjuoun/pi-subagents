/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, readFileSync, } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AgentManager, isTopLevelAgent } from "./agent/agent-manager.js";
import { GroupJoinManager } from "./agent/group-join.js";
import { resolveJoinMode } from "./agent/invocation.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType, stripAgentPrefix } from "./agent/mention/mention.js";
import { runMentionClone } from "./agent/mention/mention-clone.js";
import { setMaxSubagentDepth } from "./agent/nested-tools.js";
import { registerRpcHandlers } from "./agent/rpc.js";
import { getDefaultMaxTurns, normalizeMaxTurns, resolveEffectiveMaxTurns, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./agent/run-limits.js";
import { createOutputFilePath, ensureOutputFile, getOutputTranscriptDefault, setOutputTranscriptDefault, streamToOutputFile, } from "./agent/session/output-file.js";
import { setWorktreeIsolationEnabled } from "./agent/session/worktree.js";
import { getAgentConfig, getAvailableTypes, getConfig, registerAgents, resolveSpawnType, setDefaultsDisabled, setFallbackSubagent } from "./config/registry/agent-types.js";
import { loadCustomAgents } from "./config/registry/custom-agents.js";
import { applyAndEmitLoaded, loadSettings } from "./config/settings.js";
import { ActivationContext } from "./extension/context.js";
import { inChildSessionContext } from "./lib/child-context.js";
import { SUBAGENT_TOOL_NAMES } from "./lib/tool-names.js";
import { type AgentRecord, type NotificationDetails, } from "./lib/types.js";
import { formatCost, formatMs, formatTokens, formatTurns } from "./lib/ui/format.js";
import type { AgentActivity, UICtx } from "./lib/ui/theme.js";
import { getLifetimeTotal, PendingUsagePool, toReportedUsage } from "./lib/usage.js";
import { setScopeModelsEnabled } from "./model/model-scope.js";
import { SubagentScheduler } from "./schedule/schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule/schedule-store.js";
import { createAgentTool } from "./tools/agent.js";
import type { ToolsDeps } from "./tools/deps.js";
import { createGetSubagentResultTool } from "./tools/get-subagent-result.js";
import { createSteerSubagentTool } from "./tools/steer-subagent.js";
import { registerToolReportingUsage, withUsageReporting } from "./tools/usage-reporting.js";
import { createWorkflowTool, fleetWorkflows, runWorkflowTask } from "./tools/workflow.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import { createActivityTracker, renderRunningAgentStatus } from "./ui/agent-status.js";
import { AgentStatusBar } from "./ui/agent-status-bar.js";
import { showAgentViewMenu } from "./ui/agent-view-menu.js";
import type { AgentsUiDeps } from "./ui/agents/deps.js";
import { showAgentsMenu } from "./ui/agents/menu.js";
import { viewAgentConversation } from "./ui/agents/running.js";
import { FleetList, type FleetUICtx, } from "./ui/fleet-list.js";
import { buildNotificationDetails, formatTaskNotification, } from "./ui/notifications.js";
import { renderWorkflowEntryCard } from "./ui/workflow/workflow-card.js";
import { openWorkflowFromFleet, type WorkflowMenuDeps } from "./ui/workflow/workflow-menu.js";
import { decideWorkflowCollision, FOREIGN_WORKFLOW_TOOL_NAMES } from "./workflow/collisions.js";
import { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG, type WorkflowEntryData, workflowEntryData } from "./workflow/run/entry.js";
import { createWorkflowTask, formatWorkflowNotification, type WorkflowTask, workflowRunId } from "./workflow/run/task.js";
import { extractMeta, type WorkflowMeta, } from "./workflow/script/meta.js";

// ---- Re-exports ----

/**
 * Re-exported from where they now live, because this is where they were defined and both a
 * consumer and a test import them from `src/index.js`: `renderRunningAgentStatus`
 * (test/agent-widget.test.ts), `WORKFLOW_FILE_FLAG` and `WORKFLOW_ENTRY_TYPE`
 * (test/workflow-tool.test.ts). Everything else that lived in the block above moved without a
 * forwarding alias — its importers were updated directly.
 */
export { FOREIGN_WORKFLOW_TOOL_NAMES, renderRunningAgentStatus, WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG, type WorkflowEntryData, workflowEntryData };

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and leak handlers. Nested orchestration is
  // injected as scoped custom tools by the existing manager instead.
  if (inChildSessionContext()) return;

  // The activation's own state — every cluster below reads and writes through this.
  const context = new ActivationContext();

  // ---- Register custom notification renderer ----
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
        if (context.showCost) {
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
      if (context.showCost && all.length > 1) {
        const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
        if (total) {
          const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
          rendered.unshift(theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`));
        }
      }
      return new Text(rendered.join("\n"), 0, 0);
    }
  );

  // ---- Workflow run rendered as a session entry ----
  // A workflow launched from the CLI flag has no tool call to hang its result
  // card on, so it renders here instead — through the SAME layout the tool
  // result uses, not a second one. Custom entries with no registered renderer
  // are silently dropped by the host, which is why this is registered at
  // activation rather than lazily.
  pi.registerEntryRenderer<WorkflowEntryData>(WORKFLOW_ENTRY_TYPE, (entry, _options, theme) =>
    renderWorkflowEntryCard(entry.data, theme));

  // Registered at activation; READ from session_start. The host applies CLI
  // values after every extension factory has run, so `getFlag` here would only
  // ever hand back the registered default (see the read site below).
  pi.registerFlag(WORKFLOW_FILE_FLAG, {
    type: "string",
    description:
      `Run a workflow script at startup: --${WORKFLOW_FILE_FLAG}=<path>. ` +
      "Use the `=` form — the space form consumes the next argument, which would swallow a following prompt.",
  });

  // Read directly rather than waiting for applyAndEmitLoaded below: this decides
  // the initial load, which happens hundreds of lines before settings are applied.
  context.strictAgentFiles = loadSettings(process.cwd()).strictAgentFiles === true;

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(context.strictAgentFiles);

  // ---- Agent activity tracking + widget ----
  context.agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  context.reportUsage = false;
  /** Show `~$X` next to token counts in the subagent surfaces. */
  context.showCost = false;
  /** Name the model and thinking level on the widget's running rows. */
  context.showModel = false;
  /**
   * How much of the conversation viewer renders as Markdown. Read through a
   * getter by the viewer rather than captured like `showCost`, because the
   * `/agents → Settings` writes here.
   */
  context.viewerMarkdown = "all";
  context.pendingUsage = new PendingUsagePool();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  context.pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;
  // A queued result wait must observe completion before its held notification
  // can fire, so successful waits can still suppress that redundant nudge.
  const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    context.pendingNudges.set(key, setTimeout(() => {
      context.pendingNudges.delete(key);
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = context.pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      context.pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500, context.showCost);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, context.agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    context.agentActivity.delete(record.id);
    context.status.markFinished(record.id);
    context.fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    context.status.update();
  }

  // ---- Group join manager ----
  context.groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { context.agentActivity.delete(r.id); context.status.markFinished(r.id); context.fleet.onAgentFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { context.status.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300, context.showCost)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, context.agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, context.agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      context.status.update();
    },
    30_000,
  );

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

  // Background completion: route through group join or send individual nudge
  context.manager = new AgentManager((record) => {
    // Owned children — nested, or a workflow's — report only through their
    // owner: the parent's scoped tools, or the workflow's card, notification
    // and dialog. Keep them out of top-level lifecycle, transcript,
    // notification, and UI channels.
    if (!isTopLevelAgent(record)) return;

    // Emit lifecycle event based on terminal status
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
      context.agentActivity.delete(record.id);
      context.status.markFinished(record.id);
      context.fleet.onAgentFinished(record.id);
      context.status.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (context.currentBatchAgents.some(a => a.id === record.id)) {
      context.status.update();
      return;
    }

    const result = context.groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    context.status.update();
  }, undefined, (record) => {
    if (!isTopLevelAgent(record)) return;
    // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
    // and scheduler spawns enter through the manager directly.
    if (context.currentCtx?.hasUI) {
      context.status.ensureTimer();
      context.status.update();
      context.fleet.ensureTimer();
      context.fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
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
  }, (_record, usage) => {
    // Every assistant message from every agent — nested included, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (context.reportUsage) context.pendingUsage.add(usage);
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  // Documented for callers in docs/rpc.md ("The manager registry").
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  /**
   * Per-session view of the same entry, keyed by session id.
   *
   * The single slot above is claimed by the FIRST activation in the process and released only when
   * that one shuts down, which is exactly right for the case it was written for — a child session
   * re-activating this extension must not point cross-package consumers at a short-lived child
   * manager. But a host that keeps MANY sessions in one process (a web UI, a daemon) then resolves
   * `undefined` for its own agent ids in every session but the first: `getRecord(id)` walks the
   * owner's manager. Publishing each activation under its own session id is additive — the legacy
   * slot keeps its exact semantics — and lets such a host resolve the ids it spawned, including
   * `record.sessionFile` and the live `record.session`. Documented in docs/rpc.md.
   */
  const MANAGERS_KEY = Symbol.for("pi-subagents:managers");
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    const { state, callbacks } = createActivityTracker(resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns));
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    const id = context.manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, ...callbacks });
    context.agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    // Internal too: a forged value would hide an RPC-spawned agent inside
    // someone else's workflow, and take it out of the concurrency pool with it.
    delete safeOptions.workflowId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Every spawn through here is DETACHED — the caller gets an id back and
    // awaits nothing. A forged `blocking` would charge it to the foreground
    // pool and could defer it behind a queue whose gate nobody is holding.
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = context.manager.getRecord(ref);
    if (byId) return byId;
    const resolved = context.manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => context.manager.waitForAll(),
    hasRunning: () => context.manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = context.manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) ? record : undefined;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  context.mentionProviderRegistered = false;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  context.scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      context.scheduler.start(pi, ctx, context.manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    context.currentCtx = ctx;
    // Publish this activation's entry under its own session id too (see MANAGERS_KEY).
    const existingManagers = (globalThis as any)[MANAGERS_KEY] as Map<string, unknown> | undefined;
    const sessionManagers = existingManagers ?? new Map<string, unknown>();
    (globalThis as any)[MANAGERS_KEY] = sessionManagers;
    const ownSessionId = ctx.sessionManager?.getSessionId?.();
    if (ownSessionId) sessionManagers.set(ownSessionId, registryEntry);
    if (ctx.hasUI) {
      context.status.setUICtx(ctx.ui);
      context.fleet.setUICtx(ctx.ui as any);
    }
    context.manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!context.rpcHandle) {
      context.rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => context.currentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => context.manager.awaitStartup(id),
          getRecord: (id) => context.manager.getRecord(id),
          // Unguarded on purpose: the stop handler now runs the top-level check
          // itself off `getRecord`, and reports the refusal instead of the
          // "Agent not found" a false from here used to be read as.
          abort: (id) => context.manager.abort(id),
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record || record.parentAgentId) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            cancelNudge(record.id);
            return true;
          },
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (context.isSchedulingEnabled() && !context.scheduler.isActive()) startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !context.mentionProviderRegistered) {
      context.mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(context.manager, mentionTypes(), type => getConfig(type).displayName),
          () => context.isAgentMentionsEnabled(),
        ),
      );
    }
    // Last, and only here: CLI flag values are applied by the host AFTER every
    // extension factory has run, so this is the earliest point the real value
    // exists. Detached inside — a workflow must not hold up session startup.
    resolveWorkflowCollisions(ctx);
    runWorkflowFlag(ctx);
  });

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !context.isAgentMentionsEnabled()) return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && context.getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved = context.manager.resolveMention(mention.handle)
      ?? (alias ? context.manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        context.manager.steer(record.id, mention.message);
        pi.events.emit("subagents:steered", { id: record.id, message: mention.message });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        const config = getAgentConfig(record.type);
        const resumedRecord = await startBackgroundResume(ctx, record, mention.message, {
          outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
        });
        ctx.ui.notify(
          resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    // Evicted, but its conversation is still on disk: reopen it. This is an
    // ordinary spawn carrying a session file, so the new record picks up the
    // widget, fleet row, transcript and completion notification unchanged —
    // and `reclaim` hands it back the names the tombstone was holding.
    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      // Checked here rather than left to SessionManager.open: that runs inside
      // runAgent, whose rejection lands on the record as an agent error, not in
      // the catch below. A `/new` in another pi window or a manual delete makes
      // the conversation unrecoverable (Claude Code's `not_reachable`), so drop
      // the entry — a row that can only ever fail is worse than none — and say
      // so rather than quietly sending this message to an unrelated agent.
      if (!existsSync(entry.sessionFile)) {
        context.manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }

      // The Agent tool deliberately falls back to general-purpose for a type it
      // cannot resolve (#183), which covers a deleted file AND a merely
      // disabled one. A resume must not inherit that: reopening this
      // conversation under a different agent's prompt and tools is not
      // continuing it, and the new record would re-tombstone under the
      // substitute, so the handle would never find its way back.
      reloadCustomAgents();
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        // The tombstone stays: re-enabling the agent makes the handle work
        // again, which a drop would foreclose.
        ctx.ui.notify(`Could not resume ${target} — the ${entry.type} agent is no longer available.`, "warning");
        return { action: "handled" };
      }

      try {
        // spawnResolved, not spawnTopLevel: the latter strips
        // `resumeSessionFile` and `reclaim` as untrusted. This path is the
        // exception — both come from a tombstone this extension wrote.
        const id = spawnResolved(pi, ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaim: { handle: entry.handle, alias: entry.alias },
          resumeSessionFile: entry.sessionFile,
          isBackground: true,
        });
        // The agent may still be starting — wait, so a startup failure lands in
        // the catch below instead of being announced as a resume.
        await context.manager.awaitStartup(id);
        // The tombstone deliberately stays. `resolveMention` prefers the live
        // record holding these same names, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        // The type is already settled above, so what is left is a spawn-time
        // failure: a strict worktree-isolation error, an unusable cwd.
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    const typeHandle = mention.handle;
    const type = resolveHandleToType(typeHandle, getAvailableTypes())
      ?? (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (context.getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      void runMentionClone({ ctx, type, message: mention.message, agentTool: registeredAgentTool })
        .then(async (result) => {
          if (result.spawned) return;
          // A clone that could not run must not swallow the mention: start the
          // agent the direct way rather than leaving the user with a toast and
          // nothing running.
          try {
            const id = spawnTopLevel(pi, ctx, type, mention.message, {
              description: describeMention(mention.message),
              isBackground: true,
            });
            // Same reason as the direct path below: the agent may still be
            // starting, and a failure there must reach this catch.
            await context.manager.awaitStartup(id);
            ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            ctx.ui.notify(
              `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        });
      return { action: "handled" };
    }

    try {
      // Nothing else to pass: runAgent resolves model, thinking and max turns
      // from the agent's own config when the spawn omits them, and the
      // manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      const id = spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
      });
      // The agent may still be starting (a worktree copy is an awaited git
      // call) — report a failure that lands there as a failed start, not as a
      // "Started" toast for an agent that never ran.
      await context.manager.awaitStartup(id);
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_switch", () => {
    context.manager.clearCompleted(true);
    context.scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    context.rpcHandle?.unsubSpawn();
    context.rpcHandle?.unsubStop();
    context.rpcHandle?.unsubPing();
    context.rpcHandle?.unsubConsume();
    context.rpcHandle = undefined;
    context.currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    // Drop only this activation's per-session entries; every other session keeps its own.
    const sessionManagers = (globalThis as any)[MANAGERS_KEY] as Map<string, unknown> | undefined;
    if (sessionManagers) {
      for (const [sessionId, entry] of sessionManagers) {
        if (entry === registryEntry) sessionManagers.delete(sessionId);
      }
    }
    context.scheduler.stop();
    // Before abortAll, and not folded into it: a workflow owns a worker thread
    // as well as its children, and only its own signal terminates that.
    for (const task of context.workflowTasks.values()) task.abortController.abort();
    context.workflowTasks.clear();
    context.manager.abortAll();
    for (const timer of context.pendingNudges.values()) clearTimeout(timer);
    context.pendingNudges.clear();
    context.fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await context.manager.dispose(pi);
  });

  // Live widget: show running agents above editor.
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  context.widgetMode = "background";
  // The Agent View is the FleetView below the editor. The only other surface this extension
  // owns is the status row, and that is a line of coloured marks rather than a list — so there
  // is no second view to keep in step with the first.
  context.status = new AgentStatusBar({
    listAgents: () => context.manager.listAgents()
      .filter(isTopLevelAgent)
      .map((record) => ({ id: record.id, type: record.type, status: record.status })),
  });

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  // The setting is passed in so a conversation overlay opened here renders like one opened from
  // `/agents`; the two also share their overlay frame (VIEWER_OVERLAY).
  context.fleet = new FleetList(context.manager, context.agentActivity,
    () => context.isShowCostEnabled(), () => context.getViewerMarkdown());
  context.fleetViewEnabled = true;

  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  context.agentMentionMode = "model";

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.

  // ---- Join mode configuration ----
  context.defaultJoinMode = 'smart';

  // What an unqualified top-level spawn means. Defaults to background,
  // following Claude Code; `backgroundByDefault: false` restores the previous
  // foreground default. Nested spawns ignore this — see nested-tools.ts.
  context.backgroundByDefault = true;

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  context.schedulingEnabled = true;

  // Master switch for scripted workflows. Defaults to ON. Off means the
  // `SubagentWorkflow` tool is never registered: the model is not told the
  // feature exists (zero context cost) and has nothing to call. The
  // `/agents → Workflows` view and `--subagents-workflow-file` are refused too, so
  // there is no second door into the same machinery.
  //
  // `workflowsPinned` records that the answer came from the user — a boolean in
  // subagents.json, or the settings toggle — rather than from this default. It
  // is what `resolveWorkflowCollisions` checks before yielding to another
  // extension's workflow tool: a default may be overridden by what else is
  // loaded, an explicit choice may not.
  context.workflowsEnabled = true;
  context.workflowsPinned = false;

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  context.toolDescriptionMode = "full";

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  context.currentBatchAgents = [];
  context.batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    context.batchFinalizeTimer = undefined;
    const batchAgents = [...context.currentBatchAgents];
    context.currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++context.batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      context.groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = context.manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          context.groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = context.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking, join-mode
   * batching, the widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` + `run_in_background` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined> {
    const id = existing.id;
    const joinMode = resolveJoinMode(context.defaultJoinMode, true);
    // Assigned unconditionally: the completion notification carries this as
    // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
    // id left by the spawn that created the record. Keeping it would point the
    // orchestrator's new result at a tool call that was answered runs ago.
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    // resumeAgent has no onSessionCreated — the session predates this run —
    // so seed it directly, or the widget shows no context % for the agent.
    bgState.session = existing.session;

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
    const record = await context.manager.resume(id, prompt, undefined, {
      isBackground: true,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = context.manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    if (joinMode != null && joinMode !== 'async') {
      context.currentBatchAgents.push({ id, joinMode });
      if (context.batchFinalizeTimer) clearTimeout(context.batchFinalizeTimer);
      context.batchFinalizeTimer = setTimeout(finalizeBatch, 100);
    }

    context.agentActivity.set(id, bgState);
    // This agent already finished once, so the status row holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    context.status.markRunning(id);
    context.status.ensureTimer();
    context.status.update();
    // The FleetView is the only agent surface now, so a run started on this path has to refresh
    // it here — otherwise the agent stays invisible until some later event repaints the list.
    context.fleet.update();
    context.fleet.ensureTimer();
    context.fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
    pi.events.emit("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    context.status.setUICtx(ctx.ui as UICtx);
    context.fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    context.status.onTurnStart();
  });


  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => context.manager.setMaxConcurrent(n),
      setMaxConcurrentForeground: (n) => context.manager.setMaxConcurrentForeground(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode: (m) => context.setDefaultJoinMode(m),
      setBackgroundByDefault: (b) => context.setBackgroundByDefault(b),
      setSchedulingEnabled: (b) => context.setSchedulingEnabled(b),
      setScopeModels: setScopeModelsEnabled,
      setStrictAgentFiles: (b) => { context.strictAgentFiles = b; },
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: (m) => context.setToolDescriptionMode(m),
      setFleetView: (b) => context.setFleetViewEnabled(b),
      setAgentMentions: (m) => context.setAgentMentionMode(m),
      setRememberAgents,
      setWidgetMode: (m) => context.setWidgetMode(m),
      setOutputTranscript: setOutputTranscriptDefault,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
      setWorkflowsEnabled: (b) => context.setWorkflowsEnabled(b),
      setMaxSubagentDepth: setMaxSubagentDepth,
      setFallbackSubagent: setFallbackSubagent,
      setReportUsage: (b) => context.setReportUsage(b),
      setShowCost: (b) => context.setShowCost(b),
      setShowModel: (b) => context.setShowModel(b),
      setViewerMarkdown: (m) => context.setViewerMarkdown(m),
    },
    (event, payload) => pi.events.emit(event, payload),
  );


  // ---- Tool definitions ----
  // The definitions live in src/tools/ — see each module's header. What stays here is the
  // registration (which has to happen inside the factory body — see the workflow-collision
  // note below) and what the tools need from this body: five closures and the extension API.
  const toolsDeps: ToolsDeps = {
    pi,
    context,
    reloadCustomAgents,
    finalizeBatch,
    startBackgroundResume,
    resolveAgentRef,
    cancelNudge,
    scheduleNudge,
    queueWaitPollMs: QUEUE_WAIT_POLL_MS,
  };

  // Held rather than registered inline: the mention clone reuses this exact object, so the
  // agent it starts is an ordinary top-level spawn instead of a second implementation that
  // has to be kept in step with this one.
  const registeredAgentTool = withUsageReporting(createAgentTool(toolsDeps), toolsDeps);
  pi.registerTool(registeredAgentTool);

  // ---- Workflow tool ----

  /**
   * Live runs, by task id. The tool returns before the run finishes, so its
   * result card looks the task up here on every render rather than freezing a
   * snapshot into `details` — that is what makes the inline card follow a
   * background run.
   */
  context.workflowTasks = new Map<string, WorkflowTask>();

  const workflowTool = createWorkflowTool(toolsDeps);
  if (context.isWorkflowsEnabled()) pi.registerTool(workflowTool);

  /**
   * Act on {@link decideWorkflowCollision} — the half that needs the host.
   *
   * The policy (what counts as a conflict, what a pin changes, whether there is
   * anything left to withdraw) lives in `workflow/collisions.ts`; this is the
   * host-facing shell around it: read the registry, warn, and take our tool out
   * of the active set.
   *
   * ## Why this can only happen at session_start
   *
   * `getAllTools` throws during extension loading ("Action methods cannot be
   * called during extension loading"), and load order means a check at
   * registration time could not see an extension that has not loaded yet. So
   * the decision cannot gate `registerTool`; it has to undo it. `setActiveTools`
   * is what makes that real rather than cosmetic — pi rebuilds the system
   * prompt from the new set, and `session_start` runs before any turn, so the
   * model never sees a spec we withdrew. A later `_refreshToolRegistry` keeps
   * the active set it had and only adds names new to the registry, so ours does
   * not creep back.
   *
   * Best-effort and swallowed. A diagnostic that took the session down would be
   * worse than the collision it reports.
   */
  context.collisionsChecked = false;
  function resolveWorkflowCollisions(ctx: ExtensionContext): void {
    if (context.collisionsChecked) return;
    context.collisionsChecked = true;

    const warn = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[pi-subagents] ${message}`);
    };

    try {
      if (!context.isWorkflowsEnabled()) return;

      const verdict = decideWorkflowCollision({
        tools: pi.getAllTools(),
        // Identifies our own registration: this extension does not know its
        // install path, and the description is the one field certainly ours.
        ownDescription: workflowTool.description,
        pinned: context.isWorkflowsPinned(),
      });
      if (verdict.kind === "none") return;
      if (verdict.kind === "report") {
        warn(verdict.message);
        return;
      }

      context.workflowsEnabled = false; // not setWorkflowsEnabled: this is not the user pinning it
      context.status.update();
      context.fleet.update();
      warn(verdict.message);

      if (!verdict.withdraw) return;
      const active = pi.getActiveTools();
      if (active.includes(SUBAGENT_TOOL_NAMES.WORKFLOW)) {
        pi.setActiveTools(active.filter(name => name !== SUBAGENT_TOOL_NAMES.WORKFLOW));
      }
    } catch {
      // getAllTools/setActiveTools are unavailable in some hosts (print mode,
      // RPC). Not being able to check is not a reason to fail the session.
    }
  }

  /**
   * `--subagents-workflow-file=<path>` — run a script at startup, with no LLM
   * round-trip deciding whether to call the tool.
   *
   * Read here rather than at activation because that is the only place the real
   * value exists: the host activates extensions first and applies collected CLI
   * flags second, so `getFlag` during activation returns the registered default
   * and nothing else. `examples/extensions/ssh.ts` reads its flag from
   * session_start for exactly this reason.
   */
  context.workflowFlagHandled = false;
  function runWorkflowFlag(ctx: ExtensionContext): void {
    if (context.workflowFlagHandled) return;
    const flag = pi.getFlag(WORKFLOW_FILE_FLAG);
    if (flag === undefined || flag === false) return;
    context.workflowFlagHandled = true;

    const report = (message: string, level: "info" | "warning") => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else console.warn(`[pi-subagents] ${message}`);
    };

    // The flag is the same machinery by another door, so the master switch has
    // to close it too — silently ignoring a flag the user typed would be worse
    // than saying why nothing ran.
    if (!context.isWorkflowsEnabled()) {
      report(
        `--${WORKFLOW_FILE_FLAG} ignored: workflows are off. Turn them on in /agents → Settings → Workflows, ` +
          'or set `"workflowsEnabled": true` in .pi/subagents.json.',
        "warning",
      );
      return;
    }

    // A bare `--subagents-workflow-file` parses to boolean `true`. Say what was
    // missing rather than reading a file called "true".
    if (typeof flag !== "string" || flag.trim() === "") {
      report(`--${WORKFLOW_FILE_FLAG} needs a path: --${WORKFLOW_FILE_FLAG}=<path>`, "warning");
      return;
    }

    const path = isAbsolute(flag.trim()) ? flag.trim() : join(ctx.cwd, flag.trim());
    let script: string;
    try {
      script = readFileSync(path, "utf-8");
    } catch (err) {
      report(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }

    let meta: WorkflowMeta | undefined;
    try {
      meta = extractMeta(script).meta;
    } catch (err) {
      report(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const task = createWorkflowTask({ id: workflowRunId(), script, scriptPath: path, meta });
    context.workflowTasks.set(task.id, task);
    context.status.update();
    context.fleet.update();
    report(`Running workflow ${meta.name}…`, "info");

    // Detached: session_start is awaited by the host, and a workflow can run for
    // minutes — blocking here would hold the whole session's startup.
    void runWorkflowTask(toolsDeps, ctx, task).then(() => {
      // No tool call to attach a result card to, so the card becomes a session
      // entry (same layout), and the outcome is handed to the model as context
      // for its next turn rather than forcing one.
      pi.appendEntry<WorkflowEntryData>(WORKFLOW_ENTRY_TYPE, workflowEntryData(task));
      pi.sendMessage({
        customType: "workflow-result",
        content: formatWorkflowNotification(task),
        display: false,
      }, { deliverAs: "nextTurn" });
      context.status.update();
      context.fleet.update();
    });
  }

  // ---- get_subagent_result / steer_subagent tools ----
  registerToolReportingUsage(createGetSubagentResultTool(toolsDeps), toolsDeps);
  registerToolReportingUsage(createSteerSubagentTool(toolsDeps), toolsDeps);

  // What the `/agents` surfaces need from this factory body: the two closures
  // that are not state (re-reading the agent dirs, and the defaults toggle that
  // re-registers after flipping it) plus the API the settings save emits on.
  // Everything else they reach is on the context object.
  const agentsUiDeps: AgentsUiDeps = { pi, context, reloadCustomAgents, setDisableDefaultAgents };

  /**
   * What `/agents → Workflows` and the fleet list's `workflow` rows need from
   * here. One object, built once: both entry points open the same inspector,
   * and handing them different views of the session would let the two drift.
   */
  const workflowMenuDeps: WorkflowMenuDeps = {
    tasks: context.workflowTasks,
    getRecord: id => context.manager.getRecord(id),
    viewAgentConversation: (ctx, record) => viewAgentConversation(ctx, record, agentsUiDeps),
    // Read lazily: `currentCtx` is rebound on every session_start, and the
    // fleet list may act between sessions, when there is none.
    getCtx: () => context.currentCtx as unknown as ExtensionCommandContext | undefined,
  };

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx, agentsUiDeps, workflowMenuDeps); },
  });

  // `/agent` is the switch for the one Agent View, not a second agents menu: reachable in the TUI
  // and in the browser alike because it is built on `ctx.ui.select`.
  pi.registerCommand("agent", {
    description: "Show or hide the Agent View",
    handler: async (_args, ctx) => { await showAgentViewMenu(ctx, agentsUiDeps); },
  });

  context.fleet.setWorkflowSource(() => fleetWorkflows(toolsDeps), id => openWorkflowFromFleet(id, workflowMenuDeps));
}
