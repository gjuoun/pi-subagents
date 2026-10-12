import { dirname } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { GENERAL_PURPOSE_SYSTEM_PROMPT } from "../domain/agent-type.js";
import type { ChildSession, SpawnSpec } from "../domain/child-session.js";
import { SessionError } from "../domain/errors.js";
import { ParentContext, type ParentContextShape } from "../services/parent-context.service.js";
import { SessionFactory, type SessionFactoryShape } from "../services/session-factory.js";
import { PiChildSession, runInChildContext } from "./pi-child-session.js";

/**
 * pi-session-factory.ts — the live SessionFactory: real child pi sessions.
 *
 * This is today's open logic relocated: it reads the per-call ParentContext instead of an
 * ExtensionContext threaded from the tool, and runs the whole construction inside the child
 * marker so a nested extension load never nests a runtime.
 */

/** Resolve a "provider/id" spec against the parent registry, else the parent model. */
function resolveChildModel(parent: ParentContextShape, spec: string | undefined) {
  if (spec === undefined) return parent.model;
  const slash = spec.indexOf("/");
  if (slash <= 0) return parent.model;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  return parent.modelRegistry?.find?.(provider, id) ?? parent.model;
}

async function openSession(parent: ParentContextShape, spec: SpawnSpec): Promise<AgentSession> {
  const cwd = parent.cwd;
  const agentDir = parent.agentDir;
  const parentSessionFile = parent.sessionFile;

  // The child is file-backed (with the parent link in its header) exactly when the parent
  // is; an in-memory parent spawns an in-memory child.
  const sessionManager = parentSessionFile
    ? SessionManager.create(cwd, dirname(parentSessionFile), { parentSession: parentSessionFile })
    : SessionManager.inMemory(cwd);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => spec.systemPrompt ?? GENERAL_PURPOSE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  // 0.80.8+ createAgentSession wants modelRuntime, but the parent context only exposes the
  // registry facade — read the runtime off it (mirrors v1's agent-runner facade read).
  const parentModelRuntime = (parent.modelRegistry as unknown as { runtime?: unknown }).runtime;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: resolveChildModel(parent, spec.model),
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: loader,
    ...(spec.tools !== undefined && { tools: [...spec.tools] }),
    ...(spec.thinking !== undefined && { thinkingLevel: spec.thinking as never }),
    excludeTools: ["Agent"],
  });

  session.setSessionName(`${spec.type}#${spec.id.slice(0, 8)}`);
  await session.bindExtensions({});
  return session;
}

const live: SessionFactoryShape = {
  open: (spec) =>
    Effect.gen(function* () {
      const parent = yield* ParentContext;
      const session = yield* Effect.tryPromise({
        try: () => runInChildContext(() => openSession(parent, spec)),
        catch: (error) => SessionError.SpawnFailed({ reason: error instanceof Error ? error.message : String(error) }),
      });
      return new PiChildSession(session, spec.id, spec.type) satisfies ChildSession;
    }),
};

export const SessionFactoryLive: Layer.Layer<SessionFactory> = Layer.succeed(SessionFactory, live);
