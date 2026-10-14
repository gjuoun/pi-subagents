import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { AgentSnapshot } from "../domain/agent.js";
import type { AgentType } from "../domain/agent-type.js";
import type { AppRuntime } from "../layers.js";
import { AgentRegistry } from "../services/agent-registry.js";
import { AgentTypeCatalog } from "../services/agent-type-catalog.js";
import { ParentContext } from "../services/parent-context.service.js";
import { parentContextFromExtension } from "./agent-tool.js";

/**
 * agents-command.ts — `/agents` (JW-166): Running agents (pick one → its conversation viewer)
 * and Agent types (read-only list → detail). Nothing here writes agent files or settings.
 */

export const AGENTS_COMMAND = "agents";

/** The detail shown for one agent type. */
export function describeType(t: AgentType): string {
  return [
    `${t.name} — ${t.description}`,
    `model: ${t.model ?? "inherit"} · thinking: ${t.thinking ?? "inherit"}`,
    `tools: ${t.tools?.join(", ") ?? "all"} · max_turns: ${t.maxTurns ?? "unlimited"} · skills: ${t.skills}`,
    `source: ${t.source ?? "?"}`,
  ].join("\n");
}

const agentLabel = (s: AgentSnapshot) => `${s.handle} · ${s.status} · ${s.description}`;

export function registerAgentsCommand(
  pi: ExtensionAPI,
  getRuntime: () => AppRuntime | undefined,
  openViewer: (ctx: ExtensionCommandContext, id: string) => Promise<void>,
): void {
  pi.registerCommand(AGENTS_COMMAND, {
    description: "Browse running agents and agent types",
    handler: async (_args, ctx) => {
      const runtime = getRuntime();
      if (runtime === undefined) return;
      const { agents, types } = await runtime.runPromise(
        Effect.gen(function* () {
          const registry = yield* AgentRegistry;
          const catalog = yield* AgentTypeCatalog;
          return { agents: yield* registry.snapshots, types: yield* catalog.list() };
        }).pipe(Effect.provideService(ParentContext, parentContextFromExtension(ctx))),
      );
      const running = `Running agents (${agents.length})`;
      const typesLabel = `Agent types (${types.length})`;
      const choice = await ctx.ui.select("Agents", [running, typesLabel]);
      if (choice === running) {
        if (agents.length === 0) return ctx.ui.notify("No agents in this session.", "info");
        const picked = await ctx.ui.select("Running agents", agents.map(agentLabel));
        const agent = agents.find((a) => agentLabel(a) === picked);
        if (agent) await openViewer(ctx, agent.id);
      } else if (choice === typesLabel) {
        if (types.length === 0) return ctx.ui.notify("No agent files found in .pi/agents or the global agents dir.", "info");
        const picked = await ctx.ui.select("Agent types", types.map((t) => t.name));
        const type = types.find((t) => t.name === picked);
        if (type) ctx.ui.notify(describeType(type), "info");
      }
    },
  });
}
