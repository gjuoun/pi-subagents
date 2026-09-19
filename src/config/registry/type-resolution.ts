/**
 * type-resolution.ts — resolving a caller-supplied agent type against a registry that is PASSED IN.
 *
 * Split from `agent-types.ts`, which is the process-wide registry. Every function here takes the
 * registry as its first argument — which is what the `In` suffix has always meant, and what makes the
 * resolution testable without a global. `agent-types.ts` keeps the wrappers that supply the process
 * registry; `resolveSpawnTypeIn` reads the fallback policy from `fallback.ts`.
 */

import type { AgentConfig } from "../../lib/types.js";
import { getFallbackSubagent, NO_FALLBACK } from "./fallback.js";
/** Resolve a type name case-insensitively in a registry. Returns the canonical key or undefined. */
export function resolveTypeIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of registry.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Get the agent config for a type (case-insensitive) from a registry. */
export function getAgentConfigIn(registry: Map<string, AgentConfig>, name: string): AgentConfig | undefined {
  const key = resolveTypeIn(registry, name);
  return key ? registry.get(key) : undefined;
}

/** Check if a type is valid and enabled (case-insensitive) in a registry. */
export function isValidTypeIn(registry: Map<string, AgentConfig>, type: string): boolean {
  const key = resolveTypeIn(registry, type);
  if (!key) return false;
  return registry.get(key)?.enabled !== false;
}

/** Get all enabled type names in a registry (for spawning and tool descriptions). */
export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/**
 * Case-insensitive resolution that refuses to guess. An exact match always wins;
 * otherwise the name must match exactly one key. Two agents differing only in
 * case are reachable (`loadCustomAgents` keys by filename across three
 * directories), and picking whichever came first would silently dispatch a
 * different agent, model and tool policy than the caller meant.
 */
function resolveUnambiguousKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...registry.keys()].filter(key => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The canonical key for a caller-supplied name that identifies exactly one
 * ENABLED agent, or undefined. Strict by construction: no fallback, no guessing
 * between case-variants. Nested delegation resolves with this directly, since
 * "unknown types are rejected rather than falling back" is its own contract.
 */
export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): string | undefined {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return undefined;
  const key = resolveUnambiguousKeyIn(registry, raw);
  return key !== undefined && registry.get(key)?.enabled !== false ? key : undefined;
}

/** Outcome of resolving a caller-supplied `subagent_type` into a spawnable type. */
export type SpawnTypeResolution =
  /** Spawn this type. `fellBackFrom` is set when it isn't what the caller asked for. */
  | { ok: true; type: string; fellBackFrom?: string }
  /** Refuse the spawn and return this message to the caller. */
  | { ok: false; message: string };

/**
 * Resolve a caller-supplied agent type against a registry, applying the
 * `fallbackSubagent` policy. The single decision point for every caller-supplied
 * spawn — the Agent tool, the scheduler, cross-extension RPC, and the nested
 * tools — so a type that fails here never reaches `runAgent`, where `getConfig`
 * would silently substitute general-purpose.
 *
 * Unknown, disabled, and case-ambiguous names are all treated the same way:
 * the caller named something that doesn't identify exactly one enabled agent.
 *
 * Pure over `registry` — callers that need fresh agent files reload before
 * calling (the Agent tool already does, per spawn). Reloading here would mean
 * importing custom-agents.ts, which imports this module.
 */
export function resolveSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): SpawnTypeResolution {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";

  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };

  // A missing type follows the same policy as a wrong one rather than always
  // erroring: before this setting existed an empty type fell back like any
  // other unresolvable name, and only opting in should change that.
  const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";

  // Trimmed like `requested`: a padded value set programmatically would
  // otherwise be reported as a missing agent.
  const configured = typeof getFallbackSubagent() === "string" ? getFallbackSubagent()!.trim() : undefined;

  if (configured !== undefined && configured.toLowerCase() === NO_FALLBACK) {
    return { ok: false, message: `${reason} Available: ${available()}.` };
  }

  if (configured !== undefined) {
    // An explicitly configured fallback that is itself unusable is a
    // misconfiguration, not a second chance to guess — say so rather than
    // quietly dropping to general-purpose.
    const fallbackKey = resolveUnambiguousKeyIn(registry, configured);
    if (fallbackKey === undefined || registry.get(fallbackKey)?.enabled === false) {
      return {
        ok: false,
        message:
          `${reason} The configured fallbackSubagent "${configured}" is itself ` +
          `unknown or disabled. Available: ${available()}.`,
      };
    }
    return { ok: true, type: fallbackKey, fellBackFrom: raw };
  }

  // Unset: historical behavior, deliberately unchanged. #183 asks for the
  // fallback to remain the default, so the pre-existing hole it leaves — an
  // unregistered general-purpose resolving to `getConfig`'s all-tools hardcoded
  // tier — is what `fallbackSubagent: none` is for, not something to close
  // under everyone silently.
  return { ok: true, type: "general-purpose", fellBackFrom: raw };
}
