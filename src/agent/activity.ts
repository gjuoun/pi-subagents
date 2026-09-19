/**
 * activity.ts — the live activity state of a running agent, and the callbacks that feed it.
 *
 * Moved out of ui/agent-result-status.ts, where it sat because it was split off the transcript row it
 * feeds. It is not presentation: it is the run's own state — which tools are open, how many have
 * closed, the turn count, the session handle — that the status row, the fleet list and the
 * workflow card all render. ui/agent-result-status.ts keeps the drawing and imports this.
 *
 * The shape it produces stays in lib/ui/theme.ts, the contract every renderer names. This module
 * only creates it — and it lives here because the spawn paths that create it for a programmatic
 * spawn (the registry, the RPC path) are in this domain, which may not import ui/ (#181).
 */

import type { AgentActivity } from "../lib/ui/theme.js";
import type { LifetimeUsage } from "../lib/usage.js";

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
