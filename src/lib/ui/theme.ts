/**
 * theme.ts — the shared UI contract every widget surface draws against.
 *
 * `Theme`/`UICtx` are pi's rendering surface, not this extension's. Four sibling files
 * (`fleet-list`, `workflow-card`, `workflow-dialog`, `conversation-viewer`) used to import
 * `ui/agent-widget.ts` — a 666-line component — purely to borrow the two-method type.
 *
 * `AgentActivity`/`AgentDetails` are here for the same reason: they are the data shapes the
 * widget is *handed*, not part of it, and every surface that reads them (the widget, the fleet
 * list, the conversation viewer, the Agent tool's result and its notification) used to reach
 * into the component for the declaration.
 *
 * Deliberately dependency-free apart from `SessionLike`: this is the leaf of the UI import
 * graph, so anything that renders can depend on it without dragging a component or an agent in
 * behind it.
 */

import type { SessionLike } from "../usage.js";

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  /**
   * Paint a row with one of pi's background colors.
   *
   * Optional because a theme is not required to have one — pi's own `Theme` does, and a test
   * double that only implements `fg`/`bold` renders no tint rather than failing.
   */
  bg?(color: string, text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short label for the model the run used, e.g. "haiku 4.5". */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
  agentId?: string;
  error?: string;
}
