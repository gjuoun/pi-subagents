/**
 * jev/state.ts — roster criteria and state assembly for the `jev` tool.
 *
 * DI via parameters (types/describe/routingRules) so the suite stays offline,
 * and the routing-rules source stays configuration (env override → known shadow
 * path → omitted) rather than code the extension ships opinionated about.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentConfig, getAvailableTypes } from "../../config/registry/agent-types.js";

/** Default situation paragraph — the one the live probe settled on 2026-09-18. */
export const SITUATION_DEFAULT =
  "Dispatch decision for a personal agent stack. The orchestrator (shadow) just received the TASK below and must pick the ONE specialist subagent to execute it. Every available agent's definition follows. Pick the single best-fit agent. If the task is genuinely ambiguous or best done inline by the orchestrator, still pick the closest specialist. Answer with exactly one agent choice.";

/**
 * Map enabled agent types to the `choice` criteria (name → description).
 * Types without a describable description are dropped — a criterion with no
 * prose is exactly the input a literal-minded decision model answers badly.
 */
export function buildRosterCriteria(
  types: string[] = getAvailableTypes(),
  describe: (type: string) => string | undefined = (type) => getAgentConfig(type)?.description,
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const type of types) {
    const desc = describe(type)?.trim();
    if (desc) criteria[type] = desc;
  }
  return criteria;
}

/**
 * The routing-rules source: `JEV_ROUTING_RULES` env path if set and readable,
 * else shadow's own routing ruleset if it exists on this machine, else omitted
 * (the tool must work on machines without shadow's skills repo).
 */
export function routingRulesText(): string | undefined {
  const fromEnv = process.env.JEV_ROUTING_RULES?.trim();
  if (fromEnv) {
    try { return readFileSync(fromEnv, "utf8"); } catch { return undefined; }
  }
  const fallback = join(homedir(), ".jun", "skills", "role", "shadow", "agent-routing.md");
  try { return readFileSync(fallback, "utf8"); } catch { return undefined; }
}

/**
 * The one atomic `choice` question the live probe settled on.
 */
export function buildJevQuestion(criteria: Record<string, string>): {
  agent: { type: "choice"; instructions: string; criteria: Record<string, string> };
} {
  return {
    agent: {
      type: "choice",
      instructions: "Which agent type should execute this task? Pick exactly one.",
      criteria,
    },
  };
}

/**
 * Assemble the `state`: TASK + CURRENT SITUATION + ROUTING RULES (when
 * available). `routingRules` is injectable so the missing-file branch is
 * testable without fs mocking.
 */
export function buildJevState(
  task: string,
  context?: string,
  routingRules: string | null = routingRulesText() ?? null,
): string {
  const parts = ["TASK:", task, "", "CURRENT SITUATION:", context?.trim() || SITUATION_DEFAULT];
  if (routingRules) parts.push("", "ROUTING RULES:", routingRules);
  return parts.join("\n");
}