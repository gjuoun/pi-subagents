/**
 * app.ts — the composition root: every registration this extension makes, in one place.
 *
 * This is the Hono starter template's `createApp`, adapted to a pi extension. It builds the
 * activation's handles (src/bootstrap.ts), creates the activation's state, registers the tools,
 * commands, events and renderers, and wires the domain modules to each other. The entry
 * (src/index.ts) is left with the child-session guard and this call, which is what makes the
 * registered surface readable in one pass instead of spread through a factory body.
 *
 * Layering: part of the wiring layer, like index and bootstrap — see test/layout-fence.test.ts.
 */


import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./agent/activity.js";
import { resolveJoinMode } from "./agent/invocation.js";
import { createManagerCallbacks } from "./agent/manager-callbacks.js";
import { createMentionDispatcher } from "./agent/mention/dispatch.js";
import { setMaxSubagentDepth } from "./agent/nested-tools.js";
import { createManagerRegistry } from "./agent/registry.js";
import { registerRpcHandlers } from "./agent/rpc.js";
import { setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./agent/run-limits.js";
import { createOutputFilePath, ensureOutputFile, setOutputTranscriptDefault, streamToOutputFile } from "./agent/session/output-file.js";
import { setWorktreeIsolationEnabled } from "./agent/session/worktree.js";
import { createServices } from "./bootstrap.js";
import { getAgentConfig, getAvailableTypes, getConfig, registerAgents, setDefaultsDisabled, setFallbackSubagent } from "./config/registry/agent-types.js";
import { loadCustomAgents } from "./config/registry/custom-agents.js";
import { applyAndEmitLoaded, loadSettings } from "./config/settings.js";
import { ActivationContext } from "./extension/context.js";

import type { AgentRecord } from "./lib/types.js";
import type { UICtx } from "./lib/ui/theme.js";
import { startScheduler } from "./schedule/start.js";
import { createAgentTool } from "./tools/agent.js";
import type { ToolsDeps } from "./tools/deps.js";
import { createGetSubagentResultTool } from "./tools/get-subagent-result.js";
import { createJevTool } from "./tools/jev.js";
import { createSteerSubagentTool } from "./tools/steer-subagent.js";
import { registerToolReportingUsage, withUsageReporting } from "./tools/usage-reporting.js";
import { createWorkflowTool, fleetWorkflows } from "./tools/workflow.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import type { AgentsUiDeps } from "./ui/agents/deps.js";
import { showAgentsMenu } from "./ui/agents/menu.js";
import { viewAgentConversation } from "./ui/agents/running.js";
import { createCompletionNudge } from "./ui/completion-nudge.js";
import type { FleetUICtx } from "./ui/fleet-list.js";
import { renderWorkflowEntryCard } from "./ui/workflow/workflow-card.js";
import { openWorkflowFromFleet, type WorkflowMenuDeps } from "./ui/workflow/workflow-menu.js";

import { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG, type WorkflowEntryData } from "./workflow/run/entry.js";
import { createWorkflowHosts } from "./workflow/run/session-hosts.js";




export function createExtension(pi: ExtensionAPI): void {
  // The activation's own state — every cluster below reads and writes through this.
  const context = new ActivationContext();


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




  // Every shared handle — the manager, the group joiner, the status row, the fleet list,
  // the scheduler and the four collections they share — is built in one ordered place and
  // frozen. This call supplies the completion policy (the nudge/notification logic above)
  // and is the only place any of them is constructed. See src/bootstrap.ts.
  // The manager is constructed with the completion policy, and the policy reads the handles the
  // manager is part of. The hooks it receives are therefore thin bindings, resolved when a run
  // settles — long after the two lines below — and the policy itself is built immediately after.
  const services = createServices({
    showCost: () => context.showCost,
    viewerMarkdown: () => context.viewerMarkdown,
    hooks: {
      onAgentComplete: (record) => policy.onAgentComplete(record),
      onAgentStart: (record) => policy.onAgentStart(record),
      onAgentCompact: (record, info) => policy.onAgentCompact(record, info),
      onAgentUsage: (record, usage) => policy.onAgentUsage(record, usage),
      onGroupComplete: (records, partial) => policy.onGroupComplete(records, partial),
    },
  });
  // The one handle reference the state class keeps: the surfaces a settings write repaints.
  context.repaint = services;

  /**
   * The completion policy, owned by the domains it belongs to: the notification surface (which
   * registers its own message renderer) and the manager's lifecycle callbacks.
   */
  const notify = createCompletionNudge({ pi, services, showCost: () => context.showCost, batch: context });
  const policy = {
    ...createManagerCallbacks({ pi, services, context, notify }),
    onGroupComplete: notify.onGroupComplete,
  };


  const { MANAGER_KEY, MANAGERS_KEY, spawnResolved, spawnTopLevel, resolveAgentRef, registryEntry, ownsManagerRegistry } =
    createManagerRegistry({ services, reloadAgents: () => reloadCustomAgents() });

  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).

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
      services.status.setUICtx(ctx.ui);
      services.fleet.setUICtx(ctx.ui as any);
    }
    services.manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!context.rpcHandle) {
      context.rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => context.currentCtx,
        modelScope: services.modelScope,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => services.manager.awaitStartup(id),
          getRecord: (id) => services.manager.getRecord(id),
          // Unguarded on purpose: the stop handler now runs the top-level check
          // itself off `getRecord`, and reports the refusal instead of the
          // "Agent not found" a false from here used to be read as.
          abort: (id) => services.manager.abort(id),
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record || record.parentAgentId) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            notify.cancelNudge(record.id);
            return true;
          },
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (context.schedulingEnabled && !services.scheduler.isActive()) startScheduler({ pi, scheduler: services.scheduler, manager: services.manager }, ctx);
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
          () => mentionRoster(services.manager, mentionTypes(), type => getConfig(type).displayName),
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
  pi.on("session_before_switch", () => {
    services.manager.clearCompleted(true);
    services.scheduler.stop();
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
    services.scheduler.stop();
    // Before abortAll, and not folded into it: a workflow owns a worker thread
    // as well as its children, and only its own signal terminates that.
    for (const task of services.workflowTasks.values()) task.abortController.abort();
    services.workflowTasks.clear();
    services.manager.abortAll();
    for (const timer of services.pendingNudges.values()) clearTimeout(timer);
    services.pendingNudges.clear();
    services.fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await services.manager.dispose(pi);
  });

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
    const record = await services.manager.resume(id, prompt, undefined, {
      isBackground: true,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = services.manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    if (joinMode != null && joinMode !== 'async') {
      context.currentBatchAgents.push({ id, joinMode });
      if (context.batchFinalizeTimer) clearTimeout(context.batchFinalizeTimer);
      context.batchFinalizeTimer = setTimeout(notify.finalizeBatch, 100);
    }

    services.agentActivity.set(id, bgState);
    // This agent already finished once, so the status row holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    services.status.markRunning(id);
    services.status.ensureTimer();
    services.status.update();
    // The FleetView is the only agent surface now, so a run started on this path has to refresh
    // it here — otherwise the agent stays invisible until some later event repaints the list.
    services.fleet.update();
    services.fleet.ensureTimer();
    services.fleet.update();

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
    services.status.setUICtx(ctx.ui as UICtx);
    services.fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    services.status.onTurnStart();
  });


  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      services,
      context,
      setDefaultMaxTurns,
      setGraceTurns,
      setMaxSubagentDepth,
      setFallbackSubagent,
      setDisableDefaultAgents,
      setRememberAgents,
      setOutputTranscript: setOutputTranscriptDefault,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );


  // The definitions live in src/tools/ — see each module's header. What stays here is the
  // registration (which has to happen inside the factory body — see the workflow-collision
  // note below) and what the tools need from this body: five closures and the extension API.
  const toolsDeps: ToolsDeps = {
    pi,
    services,
    context,
    reloadCustomAgents,
    finalizeBatch: notify.finalizeBatch,
    startBackgroundResume,
    resolveAgentRef,
    cancelNudge: notify.cancelNudge,
    scheduleNudge: notify.scheduleNudge,
    queueWaitPollMs: notify.queueWaitPollMs,
  };

  // Held rather than registered inline: the mention clone reuses this exact object, so the
  // agent it starts is an ordinary top-level spawn instead of a second implementation that
  // has to be kept in step with this one.
  const registeredAgentTool = withUsageReporting(createAgentTool(toolsDeps), toolsDeps);
  pi.registerTool(registeredAgentTool);

  // The `@handle` dispatcher: the mention grammar, the steer and resume paths, and the start
  // path — its own domain, which installs the input hook on construction. Registered here
  // because a clone reuses the Agent tool above.
  createMentionDispatcher({
    pi, services, context, spawnResolved, spawnTopLevel, reloadCustomAgents,
    startBackgroundResume, agentTool: registeredAgentTool,
  });


  const workflowTool = createWorkflowTool(toolsDeps);
  if (context.workflowsEnabled) pi.registerTool(workflowTool);

  const jevTool = createJevTool(toolsDeps);
  if (context.jevEnabled) pi.registerTool(jevTool);

  const { resolveWorkflowCollisions, runWorkflowFlag } = createWorkflowHosts({
    pi, services, context, runDeps: toolsDeps, toolDescription: workflowTool.description,
  });

  registerToolReportingUsage(createGetSubagentResultTool(toolsDeps), toolsDeps);
  registerToolReportingUsage(createSteerSubagentTool(toolsDeps), toolsDeps);

  // What the `/agents` surfaces need from this factory body: the two closures
  // that are not state (re-reading the agent dirs, and the defaults toggle that
  // re-registers after flipping it) plus the API the settings save emits on.
  // Everything else they reach is on the context object.
  const agentsUiDeps: AgentsUiDeps = { pi, services, context, reloadCustomAgents, setDisableDefaultAgents };

  /**
   * What `/agents → Workflows` and the fleet list's `workflow` rows need from
   * here. One object, built once: both entry points open the same inspector,
   * and handing them different views of the session would let the two drift.
   */
  const workflowMenuDeps: WorkflowMenuDeps = {
    tasks: services.workflowTasks,
    getRecord: id => services.manager.getRecord(id),
    viewAgentConversation: (ctx, record) => viewAgentConversation(ctx, record, agentsUiDeps),
    // Read lazily: `currentCtx` is rebound on every session_start, and the
    // fleet list may act between sessions, when there is none.
    getCtx: () => context.currentCtx as unknown as ExtensionCommandContext | undefined,
  };

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx, agentsUiDeps, workflowMenuDeps); },
  });

  services.fleet.setWorkflowSource(() => fleetWorkflows(toolsDeps), id => openWorkflowFromFleet(id, workflowMenuDeps));
}
