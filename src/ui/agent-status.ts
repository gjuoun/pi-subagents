/**
 * agent-status.ts — how a running agent reports itself on the transcript row.
 *
 * The status container the Agent tool's call line draws, its spinner, and the completion labels.
 * Pure presentation — no `pi.*` call, no activation-scope state. The activity *state* it renders
 * lives in `agent/activity.ts`: the spawn paths that create it may not import `ui/`, the same
 * way `THINKING_LEVELS` left for `lib/agent-meta.ts`.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { formatTokens } from "../lib/ui/format.js";
import type { Theme } from "../lib/ui/theme.js";
import { getLifetimeTotal, type LifetimeUsage } from "../lib/usage.js";

/**
 * Braille spinner frames for the running indicator.
 *
 * Moved here when the above-editor widget was deleted: three surfaces draw it (the transcript's
 * running line, the workflow card, the workflow dialog) and none of them should import a widget
 * that no longer exists.
 */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg"> & { bg?: Theme["bg"] },
  bgColor?: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg",
): Container {
  const bgFn = bgColor && theme.bg ? (text: string) => theme.bg!(bgColor, text) : undefined;
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0, bgFn));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0, bgFn));
  return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** Human-readable status label for agent completion. */
export function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}
