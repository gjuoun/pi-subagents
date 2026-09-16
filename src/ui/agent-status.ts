/**
 * agent-status.ts — how a running agent reports itself on the transcript row.
 *
 * Moved out of `index.ts` as-is: the status container the Agent tool's call line draws, the
 * activity tracker that feeds it, and the two vocabularies they share (`THINKING_LEVELS` and
 * the completion labels). Pure presentation — no `pi.*` call, no activation-scope state.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { formatTokens } from "../lib/ui/format.js";
import type { AgentActivity, Theme } from "../lib/ui/theme.js";
import { getLifetimeTotal, type LifetimeUsage } from "../lib/usage.js";

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

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => {
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
