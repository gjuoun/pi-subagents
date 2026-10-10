import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FiberMap, Layer, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { Agent, type AgentSnapshot } from "../domain/agent.js";
import { type AgentNotFound, RegistryError, renderSessionError, type SpawnFailed, type V2Error } from "../domain/errors.js";
import { SubagentResultMessage } from "../domain/subagent-result.js";
import { ChildSession } from "../pi/pi-child-session.js";
import { PiHost } from "../pi/pi-result-notifier.js";
import type { AgentType } from "./agent-type-catalog.js";

/**
 * agent-registry.ts — the one place the extension keeps its agents.
 *
 * Snapshots (plain, published data) live in a SubscriptionRef the widget and the e2e handle
 * read; the Agent objects live beside them in a Ref. The layer finalizer aborts any still
 * running child and disposes every one, so runtime.dispose() on session_shutdown is all the
 * cleanup there is.
 */

export interface AgentRegistryShape {
  /** Spawn a child session and register a fresh agent for it. */
  readonly create: (ctx: ExtensionContext, type: AgentType, description: string) => Effect.Effect<Agent, SpawnFailed>;
  /** Register an agent around an already-open child session. */
  readonly adopt: (session: ChildSession, type: string, description: string) => Effect.Effect<Agent>;
  readonly find: (id: string) => Effect.Effect<Agent, AgentNotFound>;
  readonly runInBackground: (agent: Agent, prompt: string) => Effect.Effect<string, V2Error, PiHost>;
  readonly snapshots: Effect.Effect<ReadonlyArray<AgentSnapshot>>;
  readonly changes: Stream.Stream<ReadonlyArray<AgentSnapshot>>;
  readonly hasRunning: () => boolean;
}

export class AgentRegistry extends Context.Service<AgentRegistry, AgentRegistryShape>()(
  "pi-subagents/v2/AgentRegistry",
) {
  static readonly layer = (options: AgentRegistryOptions = {}): Layer.Layer<AgentRegistry> =>
    Layer.effect(AgentRegistry, makeAgentRegistry(options));
}

/** The cross-package handle the e2e harness reads (Symbol.for("pi-subagents:v2")). */
export const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");

export interface V2Handle {
  hasRunning(): boolean;
  waitForAll(): Promise<void>;
  list(): Array<AgentSnapshot>;
}

export interface AgentRegistryOptions {
  /** Test/observability hook fired once when the layer scope closes. */
  readonly onDispose?: () => void;
}

const updateMap = <V>(current: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => {
  const next = new Map(current);
  next.set(key, value);
  return next;
};

const makeAgentRegistry = (
  options: AgentRegistryOptions,
): Effect.Effect<AgentRegistryShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const snapshots = yield* SubscriptionRef.make<ReadonlyMap<string, AgentSnapshot>>(new Map());
    const fibers = yield* FiberMap.make<string, void, never>();
    const agents = yield* Ref.make<ReadonlyMap<string, Agent>>(new Map());

    const publish = (snapshot: AgentSnapshot): Effect.Effect<void> =>
      SubscriptionRef.update(snapshots, (byId) => updateMap(byId, snapshot.id, snapshot));

    const deliver = (agent: Agent, status: "done" | "error", body: string): Effect.Effect<void, never, PiHost> =>
      Effect.gen(function* () {
        const snapshot = yield* agent.snapshot;
        const host = yield* PiHost;
        yield* host.deliver(SubagentResultMessage.fromAgent(snapshot, status, body));
      });

    const handle: V2Handle = {
      hasRunning: () =>
        Array.from(SubscriptionRef.getUnsafe(snapshots).values()).some((s) => s.status === "running"),
      waitForAll: async () => {
        while (handle.hasRunning()) await new Promise((resolve) => setTimeout(resolve, 10));
      },
      list: () => Array.from(SubscriptionRef.getUnsafe(snapshots).values()),
    };
    (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] = handle;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        options.onDispose?.();
        const snapshotMap = SubscriptionRef.getUnsafe(snapshots);
        const agentMap = yield* Ref.get(agents);
        yield* FiberMap.clear(fibers);
        yield* Effect.forEach(
          agentMap.entries(),
          ([id, agent]) =>
            Effect.gen(function* () {
              if (snapshotMap.get(id)?.status === "running") yield* agent.abort();
              yield* agent.dispose();
            }),
          { discard: true },
        );
        if ((globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] === handle) {
          delete (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY];
        }
      }),
    );

    const adopt = (session: ChildSession, type: string, description: string): Effect.Effect<Agent> =>
      Effect.gen(function* () {
        const id = randomBytes(4).toString("hex");
        const agent = yield* Agent.make({ id, type, name: type, description, session, publish });
        yield* Ref.update(agents, (byId) => updateMap(byId, id, agent));
        return agent;
      });

    return {
      create: (ctx, type, description) =>
        Effect.gen(function* () {
          const id = randomBytes(4).toString("hex");
          const session = yield* ChildSession.open(ctx, {
            id,
            type: type.name,
            systemPrompt: type.systemPrompt,
            tools: type.tools,
            model: type.model,
            thinking: type.thinking,
          });
          return yield* adopt(session, type.name, description);
        }),
      adopt,
      find: (id) =>
        Ref.get(agents).pipe(
          Effect.flatMap((byId) => {
            const agent = byId.get(id);
            return agent === undefined ? Effect.fail(RegistryError.AgentNotFound({ id })) : Effect.succeed(agent);
          }),
        ),
      runInBackground: (agent, prompt) =>
        Effect.gen(function* () {
          if (yield* agent.isRunning) {
            return yield* Effect.fail(RegistryError.AgentBusy({ id: agent.id, name: agent.name }));
          }
          yield* FiberMap.run(
            fibers,
            agent.id,
            agent.run(prompt).pipe(
              Effect.tap((answer) => deliver(agent, "done", answer)),
              Effect.catchTag("RunFailed", (error) => deliver(agent, "error", renderSessionError(error))),
              Effect.catchTag("AgentBusy", () => Effect.void),
            ),
          );
          const snapshot = yield* agent.snapshot;
          return `Started ${snapshot.type} (id ${snapshot.id}) in the background — its result will arrive as a message.`;
        }),
      snapshots: SubscriptionRef.get(snapshots).pipe(Effect.map((byId) => Array.from(byId.values()))),
      changes: SubscriptionRef.changes(snapshots).pipe(Stream.map((byId) => Array.from(byId.values()))),
      hasRunning: handle.hasRunning,
    } satisfies AgentRegistryShape;
  });
