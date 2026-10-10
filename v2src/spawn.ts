import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { GENERAL_PURPOSE_SYSTEM_PROMPT } from "./agent-types.js";
import { SpawnFailed } from "./errors.js";

/**
 * spawn.ts — create one child pi session.
 *
 * The pi boundary: every call here is a plain SDK promise wrapped in tryPromise, and
 * the whole construction runs inside an AsyncLocalStorage marker so pi loading
 * extensions FOR THE CHILD makes v2's factory return early instead of nesting a runtime.
 */

const childSessionContext = new AsyncLocalStorage<boolean>();

export const inChildSessionContext = (): boolean => childSessionContext.getStore() === true;

export const runInChildSessionContext = <T>(fn: () => Promise<T>): Promise<T> =>
  childSessionContext.run(true, fn);

export interface SpawnRequest {
  readonly id: string;
  readonly type: string;
  readonly systemPrompt?: string;
  /** Built-in tool allowlist; undefined means "all built-ins minus Agent". */
  readonly tools?: ReadonlyArray<string>;
  /** "provider/id" for the child model; falls back to the parent's model. */
  readonly model?: string;
  readonly thinking?: string;
}

/** Resolve a "provider/id" spec against the parent registry, else the parent model. */
function resolveChildModel(ctx: ExtensionContext, spec: string | undefined) {
  if (spec === undefined) return ctx.model;
  const slash = spec.indexOf("/");
  if (slash <= 0) return ctx.model;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  return ctx.modelRegistry?.find?.(provider, id) ?? ctx.model;
}

export const spawn = (
  ctx: ExtensionContext,
  req: SpawnRequest,
): Effect.Effect<AgentSession, SpawnFailed> =>
  Effect.tryPromise({
    try: () => runInChildSessionContext(() => doSpawn(ctx, req)),
    catch: (e) => new SpawnFailed({ reason: e instanceof Error ? e.message : String(e) }),
  });

async function doSpawn(ctx: ExtensionContext, req: SpawnRequest): Promise<AgentSession> {
  const cwd = ctx.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const parentSessionFile = ctx.sessionManager?.getSessionFile?.();

  // The child is file-backed (with the parent link in its header) exactly when the parent
  // is; an in-memory parent spawns an in-memory child.
  const sessionManager = parentSessionFile
    ? SessionManager.create(cwd, dirname(parentSessionFile), { parentSession: parentSessionFile })
    : SessionManager.inMemory(cwd);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => req.systemPrompt ?? GENERAL_PURPOSE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  // 0.80.8+ createAgentSession wants modelRuntime, but ExtensionContext only exposes the
  // registry facade — read the runtime off it (mirrors v1's agent-runner facade read).
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: resolveChildModel(ctx, req.model),
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: loader,
    ...(req.tools !== undefined && { tools: [...req.tools] }),
    ...(req.thinking !== undefined && { thinkingLevel: req.thinking as never }),
    excludeTools: ["Agent"],
  });

  session.setSessionName(`${req.type}#${req.id.slice(0, 8)}`);
  await session.bindExtensions({});
  return session;
}
