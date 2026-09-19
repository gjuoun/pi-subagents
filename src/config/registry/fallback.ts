/**
 * fallback.ts — the `fallbackSubagent` setting: what happens when a caller names a type that does
 * not identify exactly one enabled agent.
 *
 * Its own module because two halves of the registry need it and neither owns it: the resolution in
 * `type-resolution.ts` applies the policy, and `agent-types.ts` re-exports it to the settings
 * surface. Keeping the state here is what lets that resolution stay keyed on its parameter instead.
 */
/** `fallbackSubagent` value that disables the fallback entirely (strict dispatch). */
export const NO_FALLBACK = "none";

/**
 * Agent type substituted when a caller-supplied `subagent_type` doesn't resolve
 * to exactly one enabled agent. `undefined` keeps the historical behavior
 * (general-purpose); `NO_FALLBACK` makes dispatch fail closed. Set from
 * `subagents.json` (`fallbackSubagent`).
 *
 * Module state rather than an index.ts closure because every caller-supplied
 * spawn path needs it — the Agent tool, the scheduler, and cross-extension RPC.
 */
let fallbackSubagent: string | undefined;

/** Get the configured fallback agent type. undefined = general-purpose. */
export function getFallbackSubagent(): string | undefined { return fallbackSubagent; }

/** Set the configured fallback agent type. undefined = general-purpose. */
export function setFallbackSubagent(v: string | undefined): void { fallbackSubagent = v; }
