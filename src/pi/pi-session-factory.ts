import { basename, dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import type { ChildSession, SpawnSpec } from "../domain/child-session.js";
import { SessionError } from "../domain/errors.js";
import { FORK_PLACEHOLDER, FORK_REFUSAL, type ForkSource } from "../domain/fork.js";
import { selectChildTools, type ToolRef } from "../domain/tool-selection.js";
import { ParentContext, type ParentContextShape } from "../services/parent-context.service.js";
import { SessionFactory, type SessionFactoryShape } from "../services/session-factory.js";
import { AgentTool } from "./agent-tool.js";
import { GetResultTool } from "./get-result-tool.js";
import { PiChildSession, runInChildContext } from "./pi-child-session.js";
import { SteerTool } from "./steer-tool.js";

/**
 * pi-session-factory.ts — the live SessionFactory: real child pi sessions.
 *
 * This is today's open logic relocated: it reads the per-call ParentContext instead of an
 * ExtensionContext threaded from the tool, and runs the whole construction inside the child
 * marker so a nested extension load never nests a runtime.
 */

/**
 * Resolve the child model: undefined inherits the parent's; otherwise an exact "provider/id"
 * in the parent registry, or UnknownModel — never a silent fallback (JW-166: no fuzzy resolver).
 */
function resolveChildModel(
  parent: ParentContextShape,
  spec: SpawnSpec,
): Effect.Effect<Model<Api> | undefined, SessionError> {
  if (spec.model === undefined) return Effect.succeed(parent.model);
  const slash = spec.model.indexOf("/");
  const found =
    slash > 0 ? parent.modelRegistry?.find?.(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
  return found !== undefined
    ? Effect.succeed(found)
    : Effect.fail(SessionError.UnknownModel({ model: spec.model, agent: spec.type }));
}

/** The addendum a child carries: the active-agent tag, then the agent file's body. */
export function childAddendum(spec: SpawnSpec): string {
  const tag = `<active_agent name="${spec.type}"/>`;
  const persona = spec.systemPrompt?.trim();
  return persona ? `${tag}\n\n${persona}` : tag;
}

/**
 * The subagent tools a fork declares exactly as the parent does (same name, description, schema
 * and snippet, so the cached prompt prefix holds) but which refuse to run: forks do the work.
 */
function refusingSubagentTools(): ToolDefinition[] {
  const never = (): never => {
    throw new Error("refusing tool has no runtime");
  };
  const refuse = async () => ({ content: [{ type: "text" as const, text: FORK_REFUSAL }], details: undefined });
  return [new AgentTool(never).definition, new GetResultTool(never).definition, new SteerTool(never).definition].map(
    (definition) => ({ ...definition, execute: refuse }) as unknown as ToolDefinition,
  );
}

/**
 * A fork's session: the parent's active branch up to this turn's assistant message, then one
 * identical placeholder result per tool call in it. The directive arrives as the first prompt.
 */
async function openForkSession(parent: ParentContextShape, spec: SpawnSpec, fork: ForkSource): Promise<AgentSession> {
  const cwd = parent.cwd;
  const agentDir = parent.agentDir;
  const sessionManager = SessionManager.open(fork.parentFile, dirname(fork.parentFile));
  sessionManager.createBranchedSession(fork.leafId);
  const leaf = sessionManager.getLeafEntry();
  const blocks =
    leaf?.type === "message" && leaf.message.role === "assistant"
      ? (leaf.message.content as ReadonlyArray<{ type: string; id?: string; name?: string }>)
      : [];
  for (const call of blocks.filter((b) => b.type === "toolCall")) {
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: call.id ?? "",
      toolName: call.name ?? "",
      content: [{ type: "text", text: FORK_PLACEHOLDER }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  // The parent's prompt, rebuilt by pi from the same sources: its addendum is the one part pi
  // cannot rediscover (it came from --append-system-prompt or a hook), so it is passed in.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    appendSystemPromptOverride: () => (fork.addendum ? [fork.addendum] : []),
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const parentModelRuntime = (parent.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: parent.model,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: loader,
    customTools: refusingSubagentTools(),
    ...(parent.thinking !== undefined && { thinkingLevel: parent.thinking as never }),
  });
  session.setSessionName(`${spec.type}#${spec.id.slice(0, 8)}`);
  await session.bindExtensions({});
  session.setActiveToolsByName([...fork.activeTools]);
  return session;
}

async function openSession(
  parent: ParentContextShape,
  spec: SpawnSpec,
  model: Model<Api> | undefined,
): Promise<AgentSession> {
  if (spec.fork !== undefined) return openForkSession(parent, spec, spec.fork);
  const cwd = parent.cwd;
  const agentDir = parent.agentDir;
  const parentSessionFile = parent.sessionFile;

  // The child is file-backed (with the parent link in its header) exactly when the parent
  // is; an in-memory parent spawns an in-memory child.
  const sessionManager = parentSessionFile
    ? SessionManager.create(cwd, dirname(parentSessionFile), { parentSession: parentSessionFile })
    : SessionManager.inMemory(cwd);

  // pil layout (JW-166): pi builds its own structured prompt — preamble, tools, rules, docs,
  // project_context (global + local AGENTS.md), skills, cwd — and the persona rides in the
  // addendum behind an <active_agent/> tag, exactly where `pil` puts the main persona. Never
  // replace the whole prompt: that collapses pi's sections and drops the tool rules.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    appendSystemPromptOverride: () => [childAddendum(spec)],
    noPromptTemplates: true,
    noThemes: true,
    ...(spec.skills === false && { noSkills: true }),
  });
  await loader.reload();

  // 0.80.8+ createAgentSession wants modelRuntime, but the parent context only exposes the
  // registry facade — read the runtime off it (mirrors v1's agent-runner facade read).
  const parentModelRuntime = (parent.modelRegistry as unknown as { runtime?: unknown }).runtime;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: loader,
    ...(spec.thinking !== undefined && { thinkingLevel: spec.thinking as never }),
  });

  session.setSessionName(`${spec.type}#${spec.id.slice(0, 8)}`);
  await session.bindExtensions({});
  applyToolsRule(session, spec);
  return session;
}

/**
 * The decided tools rule (domain/tool-selection.ts), applied to the live registry once the
 * child's extensions are bound: pi's own `tools` option only takes names and patterns, so
 * `ext:<ext>` is resolved here from each tool's registering extension.
 */
function applyToolsRule(session: AgentSession, spec: SpawnSpec): void {
  const registered: ToolRef[] = session
    .getAllTools()
    .map((t) => ({ name: t.name, extension: extensionNameOf(t.sourceInfo?.path) }));
  session.setActiveToolsByName(selectChildTools(registered, spec.tools, { platform: process.platform }));
}

/**
 * The extension a tool came from, by its source path: `builtin:<name>` and `<inline:…>` are
 * not extensions; `…/jun_code/index.ts` is `jun_code`; `…/fx.ts` is `fx`.
 */
export function extensionNameOf(path: string | undefined): string | undefined {
  if (path === undefined || path.startsWith("builtin:") || path.startsWith("<")) return undefined;
  const file = basename(path).replace(/\.(m|c)?[jt]s$/, "");
  return file === "index" ? basename(dirname(path)) : file;
}

const live: SessionFactoryShape = {
  open: (spec) =>
    Effect.gen(function* () {
      const parent = yield* ParentContext;
      const model = yield* resolveChildModel(parent, spec);
      const session = yield* Effect.tryPromise({
        try: () => runInChildContext(() => openSession(parent, spec, model)),
        catch: (error) => SessionError.SpawnFailed({ reason: error instanceof Error ? error.message : String(error) }),
      });
      return new PiChildSession(session, spec.id, spec.type, spec.maxTurns) satisfies ChildSession;
    }),
};

export const SessionFactoryLive: Layer.Layer<SessionFactory> = Layer.succeed(SessionFactory, live);
