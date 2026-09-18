/**
 * agent-status-line.ts — the extension status row: one coloured mark per agent.
 *
 * Replaces the old `"3 running, 1 queued agents"` text. Three states, and the glyph set is the
 * whole vocabulary (probed 2026-09-17 — pi's status row renders both, coloured):
 *
 *   running  → filled mark, blinking (intensity alternates, never the glyph)
 *   queued   → hollow circle, steady
 *   finished → filled mark, solid until the caller ages it out at the next turn
 *
 * Pure and timer-free: the caller owns the clock and the turn-age window, so this stays provable
 * with a unit test instead of a live terminal.
 */
import { getConfig } from "../config/registry/agent-types.js";
import type { AgentRecord } from "../lib/types.js";
import { renderAgentMark } from "./agent-color.js";

/** Blink phase. Alternating intensity, never the glyph: hollow already means `queued`. */
export type StatusPhase = 0 | 1;

/** How far a running mark dims on the off-beat. Visible, but plainly the same colour. */
export const DIM_INTENSITY = 0.35;

/** The slice of an agent the status row needs — nothing else is read. */
export interface StatusAgent {
  /** The caller's aging key — the formatter never reads it. */
  id: string;
  type: string | undefined;
  status: AgentRecord["status"];
}

/** How a type turns into a colour. Injectable so tests never touch the agent registry. */
export type ColorResolver = (type: string | undefined) => string | undefined;

const configuredColor: ColorResolver = (type) => (type ? getConfig(type).color : undefined);

/**
 * One mark per agent, in the order given, or `""` when there is nothing to show.
 *
 * The caller decides which agents are still worth a mark (finished ones age out by turn), so an
 * empty list is the only way this returns nothing.
 */
export function formatAgentStatusLine(
  agents: readonly StatusAgent[],
  phase: StatusPhase,
  resolveColor: ColorResolver = configuredColor,
): string {
  return agents
    .map((agent) => {
      const color = resolveColor(agent.type);
      if (agent.status === "queued") return renderAgentMark(color, "hollow");
      if (agent.status === "running") {
        return renderAgentMark(color, "filled", phase === 1 ? DIM_INTENSITY : 1);
      }
      return renderAgentMark(color, "filled");
    })
    .join("");
}
