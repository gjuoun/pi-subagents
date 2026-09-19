/**
 * menu.ts — `/agents`, the menu root.
 *
 * It counts what the menu can offer, then hands off to the submenu that answers a choice and
 * re-opens itself, so Back is simply "call me again". The workflow submenu arrives as a parameter
 * rather than an import because it is built in `index.ts` — one object shared by
 * `/agents → Workflows` and the fleet list's `workflow` rows, so the two entry points cannot
 * drift on what the keys do.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isTopLevelAgent } from "../../agent/agent-manager.js";
import { getAllTypes } from "../../config/registry/agent-types.js";
import { saveAndEmitChanged } from "../../config/settings.js";
import { showSchedulesMenu } from "../schedule-menu.js";
import { showWorkflowsMenu, type WorkflowMenuDeps } from "../workflow/workflow-menu.js";
import { showCreateWizard } from "./create-wizard.js";
import type { AgentsUiDeps } from "./deps.js";
import { showRunningAgents } from "./running.js";
import { showSettings, snapshotSettings } from "./settings-overlay.js";
import { showAllAgentsList } from "./type-list.js";

export async function showAgentsMenu(ctx: ExtensionCommandContext, deps: AgentsUiDeps, workflowMenuDeps: WorkflowMenuDeps): Promise<void> {
  deps.reloadCustomAgents();
  const allNames = getAllTypes();

  // Build select options
  const options: string[] = [];

  // The Agent View switch, on the root screen: /agents is the only way in, and seeing the view
  // must not need a keypress first — so the toggle is a row here rather than a hidden setting.
  // Same `fleetView` key and the same save path as the Settings row, so the two cannot drift.
  const TOGGLE_PREFIX = "Agent view: ";
  options.push(`${TOGGLE_PREFIX}${deps.context.fleetViewEnabled ? "on" : "off"}`);

  // Running agents entry (only if there are active agents)
  const agents = deps.context.manager.listAgents().filter(isTopLevelAgent);
  if (agents.length > 0) {
    const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
    const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
    options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
  }

  // Agent types list
  if (allNames.length > 0) {
    options.push(`Agent types (${allNames.length})`);
  }

  // Scheduled jobs entry (always present when scheduler is active)
  if (deps.context.scheduler.isActive()) {
    const jobCount = deps.context.scheduler.list().length;
    options.push(`Scheduled jobs (${jobCount})`);
  }

  // Workflow runs, on the same terms as scheduled jobs: shown only when the
  // feature is on, so the menu never advertises something switched off.
  if (deps.context.workflowsEnabled) {
    options.push(`Workflows (${deps.context.workflowTasks.size})`);
  }

  // Actions
  options.push("Create new agent");
  options.push("Settings");

  const noAgentsMsg = allNames.length === 0 && agents.length === 0
    ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
      "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
      "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
    : "";

  if (noAgentsMsg) {
    ctx.ui.notify(noAgentsMsg, "info");
  }

  const choice = await ctx.ui.select("Agents", options);
  if (!choice) return;

  if (choice.startsWith(TOGGLE_PREFIX)) {
    const next = !deps.context.fleetViewEnabled;
    deps.context.setFleetViewEnabled(next);
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(deps),
      `Agent view ${next ? "on" : "off"}`,
      (event, payload) => deps.pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
    await showAgentsMenu(ctx, deps, workflowMenuDeps);
  } else if (choice.startsWith("Running agents (")) {
    await showRunningAgents(ctx, deps);
    await showAgentsMenu(ctx, deps, workflowMenuDeps);
  } else if (choice.startsWith("Agent types (")) {
    await showAllAgentsList(ctx, deps);
    await showAgentsMenu(ctx, deps, workflowMenuDeps);
  } else if (choice.startsWith("Scheduled jobs (")) {
    await showSchedulesMenu(ctx, deps.context.scheduler);
    await showAgentsMenu(ctx, deps, workflowMenuDeps);
  } else if (choice.startsWith("Workflows (")) {
    await showWorkflowsMenu(ctx, workflowMenuDeps);
    await showAgentsMenu(ctx, deps, workflowMenuDeps);
  } else if (choice === "Create new agent") {
    await showCreateWizard(ctx, deps);
  } else if (choice === "Settings") {
    await showSettings(ctx, deps);
    await showAgentsMenu(ctx, deps, workflowMenuDeps);
  }
}
