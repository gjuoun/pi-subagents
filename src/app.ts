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


import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createManagerCallbacks } from "./agent/manager-callbacks.js";
import { createMentionDispatcher } from "./agent/mention/dispatch.js";
import { setMaxSubagentDepth } from "./agent/nested-tools.js";
import { createManagerRegistry } from "./agent/registry.js";

import { setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./agent/run-limits.js";
import { setOutputTranscriptDefault } from "./agent/session/output-file.js";
import { type BackgroundResumeDeps, createBackgroundResume } from "./agent/session/resume.js";
import { setWorktreeIsolationEnabled } from "./agent/session/worktree.js";
import { createServices } from "./bootstrap.js";
import { registerAgents, setDefaultsDisabled, setFallbackSubagent } from "./config/registry/agent-types.js";
import { loadCustomAgents } from "./config/registry/custom-agents.js";
import { applyAndEmitLoaded, loadSettings } from "./config/settings.js";
import { ActivationContext } from "./extension/context.js";
import { registerSessionLifecycle } from "./extension/session-lifecycle.js";
import type { UICtx } from "./lib/ui/theme.js";
import { startScheduler } from "./schedule/start.js";
import { createAgentTool } from "./tools/agent.js";
import type { ToolsDeps } from "./tools/deps.js";
import { createGetSubagentResultTool } from "./tools/get-subagent-result.js";
import { createJevTool } from "./tools/jev.js";
import { createSteerSubagentTool } from "./tools/steer-subagent.js";
import { registerToolReportingUsage, withUsageReporting } from "./tools/usage-reporting.js";
import { createWorkflowTool, fleetWorkflows } from "./tools/workflow.js";

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

  const backgroundResumeDeps: BackgroundResumeDeps = {
    pi,
    manager: services.manager,
    agentActivity: services.agentActivity,
    status: services.status,
    fleet: services.fleet,
    defaultJoinMode: () => context.defaultJoinMode,
    joinBatch: (id, joinMode) => {
      context.currentBatchAgents.push({ id, joinMode });
      if (context.batchFinalizeTimer) clearTimeout(context.batchFinalizeTimer);
      context.batchFinalizeTimer = setTimeout(notify.finalizeBatch, 100);
    },
  };
  const startBackgroundResume = createBackgroundResume(backgroundResumeDeps);

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

  registerSessionLifecycle({
    pi, context, services,
    registry: { MANAGER_KEY, MANAGERS_KEY, registryEntry, ownsManagerRegistry, spawnTopLevel, resolveAgentRef },
    notify: { cancelNudge: notify.cancelNudge },
    startScheduler: (ctx: ExtensionContext) => startScheduler({ pi, scheduler: services.scheduler, manager: services.manager }, ctx),
    resolveWorkflowCollisions,
    runWorkflowFlag,
  });

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
