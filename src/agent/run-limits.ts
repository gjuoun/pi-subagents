/**
 * run-limits.ts — the run-scoped limits the runner enforces, held in one value.
 *
 * These were three module-level `let`s inside `agent-runner.ts` (`defaultMaxTurns`,
 * `rememberAgents`, `graceTurns`) plus their six accessors, written from `settings.ts` during
 * activation and read back by the entrypoint, the schedule and the runner itself. As module
 * state inside the runner they were a global: nothing could run under a different policy, and
 * the runner could not be exercised without mutating process-wide state.
 *
 * `RunLimits` is a value now. `defaultRunLimits` is the process-wide one the settings appliers
 * write; a caller that wants its own passes it through `RunOptions.limits`.
 */

import { getAgentConfig } from "../config/registry/agent-types.js";

/** The turn caps and session-persistence policy a run executes under. */
export interface RunLimits {
  /** Project default max turns. undefined = unlimited. */
  defaultMaxTurns: number | undefined;
  /** Additional turns allowed after the soft limit steer message. */
  graceTurns: number;
  /**
   * Project default for `persist_session`, from the `rememberAgents` setting.
   * On by default: a persisted session is what lets `@handle` reopen an agent's
   * conversation after its record has been evicted, which is the whole point of
   * addressing an agent by a name that outlives one run. Per-agent frontmatter
   * still overrides it in both directions.
   */
  rememberAgents: boolean;
}

/**
 * Process-wide limits — what a run uses when its caller injects none.
 *
 * Mutable on purpose: the settings appliers overwrite fields as the user changes settings, and
 * every run started afterwards picks the new values up.
 */
export const defaultRunLimits: RunLimits = {
  defaultMaxTurns: undefined,
  graceTurns: 5,
  rememberAgents: true,
};

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/**
 * The turn limit a run of `type` will actually enforce: an explicit value if the
 * caller supplied one, else the agent's own `max_turns`, else the project
 * default. `undefined` = unlimited.
 *
 * Exported because the widget's turn counter (`↻3≤20`) has to predict this
 * before the run starts, and a second copy of the expression would drift from
 * the one below that enforces it.
 *
 * `limits` defaults to the process-wide value so a reader that only wants the
 * current setting (the widget, the settings overlay) need not name it; the runner
 * passes the value it was handed.
 */
export function resolveEffectiveMaxTurns(
  type: string,
  explicit?: number,
  limits: RunLimits = defaultRunLimits,
): number | undefined {
  return normalizeMaxTurns(explicit ?? getAgentConfig(type)?.maxTurns ?? limits.defaultMaxTurns);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultRunLimits.defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultRunLimits.defaultMaxTurns = normalizeMaxTurns(n); }

/** Whether subagent sessions are persisted by default. */
export function getRememberAgents(): boolean { return defaultRunLimits.rememberAgents; }
/** Set whether subagent sessions are persisted by default. */
export function setRememberAgents(b: boolean): void { defaultRunLimits.rememberAgents = b; }

/** Get the grace turns value. */
export function getGraceTurns(): number { return defaultRunLimits.graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { defaultRunLimits.graceTurns = Math.max(1, n); }
