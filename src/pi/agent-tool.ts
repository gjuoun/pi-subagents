import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Effect } from "effect";
import type { Agent } from "../domain/agent.js";
import { SessionError, type V2Error } from "../domain/errors.js";
import { FORK_AGENT_TYPE, FORK_TYPE, forkDirective } from "../domain/fork.js";
import type { AppRuntime } from "../layers.js";
import { AgentRegistry, type AgentRegistryShape } from "../services/agent-registry.js";
import { AgentTypeCatalog } from "../services/agent-type-catalog.js";
import { ParentContext, type ParentContextShape } from "../services/parent-context.service.js";
import { runTool, type ToolOutput } from "./boundary.js";

/**
 * agent-tool.ts — the single Agent tool.
 *
 * The execute boundary is the only place a Promise meets an Effect here: the effectful
 * program is handed to runTool, which folds the Exit back into an AgentToolResult.
 */

export const AGENT_TOOL_NAME = "Agent";

export const AGENT_TOOL_DESCRIPTION =
  "Launch a subagent to work on a task autonomously and return its final answer. " +
  "The subagent runs in its own session with its own tools. Use it to delegate a " +
  "self-contained task and get back a concise result.";

export const AgentParams = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task." }),
  prompt: Type.String({ description: "The task for the subagent to perform." }),
  subagent_type: Type.String({
    description:
      'The type of subagent to use (an agent file\'s name), or "fork" to branch this conversation: the fork continues with everything said so far and works on the prompt as its one directive.',
  }),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "Defaults to true: the agent runs detached and its result arrives as a message. Set false only when your very next action depends on the result.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Exact "provider/modelId". Used only when the agent file sets no model.' }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Thinking level. Used only when the agent file sets no thinking level." }),
  ),
  name: Type.Optional(Type.String({ description: "Optional memorable name for this agent." })),
  resume: Type.Optional(
    Type.String({ description: "An existing agent id to continue instead of spawning a new one." }),
  ),
});
type AgentArgs = Static<typeof AgentParams>;

/** Run once on a fresh or resumed agent: detached unless run_in_background is false. */
function runAgent(
  registry: AgentRegistryShape,
  agent: Agent,
  params: AgentArgs,
): Effect.Effect<string, V2Error, AgentRegistry | ParentContext> {
  return params.run_in_background === false
    ? agent.run(params.prompt)
    : registry.runInBackground(agent, params.prompt);
}

/** The call/result renderers, supplied by the composition root (pi/ may not import ui/). */
export type AgentToolRenderers = Pick<ToolDefinition<typeof AgentParams, unknown>, "renderCall" | "renderResult">;

/** The slice of the pi API a fork reads off the parent. */
export interface ParentPi {
  getActiveTools(): string[];
  getThinkingLevel(): string;
}

export class AgentTool {
  readonly #getRuntime: () => AppRuntime;
  readonly #renderers: AgentToolRenderers;
  readonly #pi: ParentPi | undefined;

  constructor(getRuntime: () => AppRuntime, renderers: AgentToolRenderers = {}, pi?: ParentPi) {
    this.#getRuntime = getRuntime;
    this.#renderers = renderers;
    this.#pi = pi;
  }

  get definition(): ToolDefinition<typeof AgentParams, unknown> {
    return defineTool({
      name: AGENT_TOOL_NAME,
      label: "Agent",
      description: AGENT_TOOL_DESCRIPTION,
      parameters: AgentParams,
      ...this.#renderers,
      execute: async (
        _toolCallId: string,
        params: AgentArgs,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) => {
        return runTool(this.#getRuntime(), this.program(ctx, params, this.#pi), signal);
      },
    });
  }

  /** The resolve -> create/find -> run program for one Agent call. */
  private program(
    ctx: ExtensionContext,
    params: AgentArgs,
    pi: ParentPi | undefined,
  ): Effect.Effect<ToolOutput, V2Error, AgentRegistry | AgentTypeCatalog> {
    return Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      // The text goes to the model; the snapshot (plain data) to the row renderer.
      const withDetails = (agent: Agent, text: string) =>
        Effect.map(agent.snapshot, (details): ToolOutput => ({ text, details }));

      if (params.resume !== undefined) {
        const agent = yield* registry.find(params.resume);
        return yield* withDetails(agent, yield* runAgent(registry, agent, params));
      }

      if (params.subagent_type === FORK_TYPE) {
        const parent = yield* ParentContext;
        if (parent.sessionFile === undefined || parent.turnKey === undefined) {
          return yield* Effect.fail(
            SessionError.ForkUnavailable({ reason: "the main session has no session file to branch (--no-session)" }),
          );
        }
        const agent = yield* registry.create(FORK_AGENT_TYPE, params.description, {
          name: params.name,
          fork: {
            parentFile: parent.sessionFile,
            leafId: parent.turnKey,
            activeTools: parent.activeTools ?? [],
            ...(parent.addendum !== undefined && { addendum: parent.addendum }),
          },
        });
        return yield* withDetails(agent, yield* runAgent(registry, agent, { ...params, prompt: forkDirective(params.prompt) }));
      }

      const catalog = yield* AgentTypeCatalog;
      const agentType = yield* catalog.resolve(params.subagent_type);
      const agent = yield* registry.create(agentType, params.description, {
        model: params.model,
        thinking: params.thinking,
        name: params.name,
      });
      return yield* withDetails(agent, yield* runAgent(registry, agent, params));
    }).pipe(Effect.provideService(ParentContext, parentContextFromExtension(ctx, pi)));
  }
}

/** The parent's addendum section content, read from its recorded system prompt. */
function parentAddendum(ctx: ExtensionContext): string | undefined {
  try {
    const sm = ctx.sessionManager;
    const messages = buildSessionContext(sm.getEntries(), sm.getLeafId()).messages;
    const section = getCurrentSystemMessage(messages as never)?.sections?.addendum;
    if (typeof section !== "string") return undefined;
    return section.replace(/^<addendum>\n?/, "").replace(/\n?<\/addendum>$/, "");
  } catch {
    return undefined;
  }
}

/** Build the per-call ParentContext from the pi extension context. */
export function parentContextFromExtension(ctx: ExtensionContext, pi?: ParentPi): ParentContextShape {
  return {
    ...(pi !== undefined && { activeTools: pi.getActiveTools(), thinking: pi.getThinkingLevel() }),
    addendum: parentAddendum(ctx),
    cwd: ctx.cwd ?? process.cwd(),
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    agentDir: getAgentDir(),
    turnKey: ctx.sessionManager?.getLeafId?.() ?? undefined,
  };
}
