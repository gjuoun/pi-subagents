/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md, .agents/agents/*.md, and global agents.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../lib/types.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import {
  getAgentConfigIn,
  getAvailableTypesIn,
  isValidTypeIn,
  resolveSpawnTypeIn,
  resolveTypeIn,
  type SpawnTypeResolution,
} from "./type-resolution.js";

/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * Lives beside {@link BUILTIN_TOOL_NAMES} rather than in `lib/`, because the full-set check
 * below is the one thing it needs and `lib/` may not reach into `config/` for it. Its callers
 * are the description builder (agent) and the entrypoint, both of which may import `config/`.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/** When true, DEFAULT_AGENTS are skipped during registration. */
let disableDefaults = false;

/** Check whether default agents are disabled. */
export function isDefaultsDisabled(): boolean { return disableDefaults; }

/** Set whether default agents are disabled. */
export function setDefaultsDisabled(b: boolean): void { disableDefaults = b; }


/**
 * Build a registry map: DEFAULT_AGENTS first (unless disabled via settings),
 * then user agents overlaid on top (same name overrides the default).
 * Pure — callers that must not disturb the process-wide registry (nested
 * delegation resolving agents from its own config root) build their own map.
 */
export function buildAgentRegistry(userAgents: Map<string, AgentConfig>): Map<string, AgentConfig> {
  const registry = new Map<string, AgentConfig>();
  if (!disableDefaults) {
    for (const [name, config] of DEFAULT_AGENTS) registry.set(name, config);
  }
  for (const [name, config] of userAgents) registry.set(name, config);
  return registry;
}

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();
  for (const [name, config] of buildAgentRegistry(userAgents)) {
    agents.set(name, config);
  }
}


/** Resolve a caller-supplied agent type against the process-wide registry. */
export function resolveSpawnType(requested: unknown): SpawnTypeResolution {
  return resolveSpawnTypeIn(agents, requested);
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveTypeIn(agents, name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  return getAgentConfigIn(agents, name);
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return getAvailableTypesIn(agents);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}


/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}
/**
 * Check if a type is valid and enabled (case-insensitive). Kept exported: the enabled /
 * disabled and case-insensitivity semantics are asserted through it in agent-types.test.ts.
 */
export function isValidType(type: string): boolean {
  return isValidTypeIn(agents, type);
}

const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const key = resolveTypeIn(agents, type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  // `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
  // (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
  return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Project an agent's config onto the `SubagentTypeConfig`-compatible shape `getConfig` returns. */
function toTypeConfig(config: AgentConfig) {
  return {
    displayName: config.displayName ?? config.name,
    color: config.color,
    description: config.description,
    builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
    extensions: config.extensions,
    excludeExtensions: config.excludeExtensions,
    skills: config.skills,
    promptMode: config.promptMode,
  };
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to general-purpose. */
export function getConfig(type: string): {
  displayName: string;
  color?: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveTypeIn(agents, type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) return toTypeConfig(config);

  // Fallback for unknown/disabled types — general-purpose config
  const gp = agents.get("general-purpose");
  if (gp && gp.enabled !== false) return toTypeConfig(gp);

  // Absolute fallback (should never happen)
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
    promptMode: "append",
  };
}

