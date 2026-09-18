/**
 * agent-view-menu.ts — `/agent`: the switch for the single Agent View.
 *
 * The primitive is `ctx.ui.select`, deliberately: it is the only *interactive* surface pi-web
 * renders natively (a real browser dialog, clickable), while the same rows appear as pi's own
 * selector in the TUI. A `custom()` overlay would work in both too, but it reaches the browser as
 * an ANSI picture driven by keystrokes only — the wrong shape for a switch.
 *
 * Persistence reuses the Settings overlay's path (`snapshotSettings` + `saveAndEmitChanged`) rather
 * than writing a second kind of file, so the flag has exactly one home.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isTopLevelAgent } from "../agent/agent-manager.js";
import { saveAndEmitChanged } from "../config/settings.js";
import type { AgentsUiDeps } from "./agents/deps.js";
import { showRunningAgents } from "./agents/running.js";
import { snapshotSettings } from "./agents/settings-overlay.js";

export interface PersistResult {
  message: string;
  level: "info" | "warning";
}

/** Write the settings snapshot the way `/agents → Settings` does, so the choice survives a restart. */
export function persistAgentView(deps: AgentsUiDeps, on: boolean): PersistResult {
  return saveAndEmitChanged(
    snapshotSettings(deps),
    `Agent view ${on ? "on" : "off"}`,
    (event, payload) => deps.pi.events.emit(event, payload),
  );
}

/**
 * Show the view's switch, its current state, and the way into the agents it lists.
 *
 * `persist` is injectable so a test can prove the toggle persists without writing the user's
 * settings file.
 */
export async function showAgentViewMenu(
  ctx: ExtensionCommandContext,
  deps: AgentsUiDeps,
  persist: (deps: AgentsUiDeps, on: boolean) => PersistResult = persistAgentView,
): Promise<void> {
  const on = deps.context.isFleetViewEnabled();
  const agents = deps.context.manager.listAgents().filter(isTopLevelAgent);

  const options = [`Agent view: ${on ? "on" : "off"}`];
  if (agents.length > 0) options.push(`Running agents (${agents.length})`);
  options.push("Done");

  const choice = await ctx.ui.select("Agent", options);
  if (!choice || choice === "Done") return;

  if (choice.startsWith("Running agents (")) {
    await showRunningAgents(ctx, deps);
    return showAgentViewMenu(ctx, deps, persist);
  }

  // The toggle row is the only other option, and it re-opens on the state it just produced —
  // the same 'call me again' shape `/agents` uses, so Back is always the same gesture.
  const next = !on;
  deps.context.setFleetViewEnabled(next);
  const { message, level } = persist(deps, next);
  ctx.ui.notify(message, level);
  return showAgentViewMenu(ctx, deps, persist);
}
