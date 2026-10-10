import { Context, Effect, FiberMap, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { Agent, type AgentSnapshot } from "../domain/agent.js";
import type { AgentType } from "../domain/agent-type.js";
import { type AgentNotFound, RegistryError, renderSessionError, type SessionError, type V2Error } from "../domain/errors.js";
import { SubagentResultMessage } from "../domain/subagent-result.js";
import { IdGenerator } from "./id-generator.js";
import type { ParentContext } from "./parent-context.js";
import { ResultNotifier } from "./result-notifier.js";
import { SessionFactory } from "./session-factory.js";

/**
 * agent-registry.ts — the one place the extension keeps its agents.
 *
 * Snapshots (plain, published data) live in a SubscriptionRef the widget and the e2e handle
 * read; the Agent objects live beside them in a Ref. The layer finalizer aborts any still
 * running child and disposes every one, so runtime.dispose() on session_shutdown is all the
 * cleanup there is.
 *
 * AgentRegistry is a class service built by its own `make`: the constructor declares its
 * dependencies (SessionFactory, ResultNotifier, IdGenerator) instead of an options bag.
 */

export interface AgentRegistryShape {
  /** Spawn a child session and register a fresh agent for it. */
  readonly create: (type: AgentType, description: string) => Effect.Effect<Agent, SessionError, ParentContext>;
  readonly find: (id: string) => Effect.Effect<Agent, AgentNotFound>;
  readonly runInBackground: (agent: Agent, prompt: string) => Effect.Effect<string, V2Error>;
  readonly snapshots: Effect.Effect<ReadonlyArray<AgentSnapshot>>;
  readonly changes: Stream.Stream<ReadonlyArray<AgentSnapshot>>;
  /** A synchronous view of the snapshot map (the e2e handle reads it). */
  readonly list: () => ReadonlyArray<AgentSnapshot>;
  readonly hasRunning: () => boolean;
}

const updateMap = <V>(current: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => {
  const next = new Map(current);
  next.set(key, value);
  return next;
};

/** The dependency constructor: declares SessionFactory, ResultNotifier and IdGenerator. */
const makeAgentRegistry: Effect.Effect<
  AgentRegistryShape,
  never,
  Scope.Scope | SessionFactory | ResultNotifier | IdGenerator
> = Effect.gen(function* () {
  const factory = yield* SessionFactory;
  const notifier = yield* ResultNotifier;
  const ids = yield* IdGenerator;
  const snapshots = yield* SubscriptionRef.make<ReadonlyMap<string, AgentSnapshot>>(new Map());
  const fibers = yield* FiberMap.make<string, void, never>();
  const agents = yield* Ref.make<ReadonlyMap<string, Agent>>(new Map());

  const list = (): ReadonlyArray<AgentSnapshot> => Array.from(SubscriptionRef.getUnsafe(snapshots).values());
  const hasRunning = (): boolean => list().some((s) => s.status === "running");

  const publish = (snapshot: AgentSnapshot): Effect.Effect<void> =>
    SubscriptionRef.update(snapshots, (byId) => updateMap(byId, snapshot.id, snapshot));

  const deliver = (agent: Agent, status: "done" | "error", body: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const snapshot = yield* agent.snapshot;
      yield* notifier.deliver(SubagentResultMessage.fromAgent(snapshot, status, body));
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
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
    }),
  );

  return {
    create: (type, description) =>
      Effect.gen(function* () {
        const id = yield* ids.next();
        const session = yield* factory.open({
          id,
          type: type.name,
          systemPrompt: type.systemPrompt,
          tools: type.tools,
          model: type.model,
          thinking: type.thinking,
        });
        const agent = yield* Agent.make({ id, type: type.name, name: type.name, description, session, publish });
        yield* Ref.update(agents, (byId) => updateMap(byId, id, agent));
        return agent;
      }),
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
    list,
    hasRunning,
  } satisfies AgentRegistryShape;
});

export class AgentRegistry extends Context.Service<AgentRegistry>()("pi-subagents/v2/AgentRegistry", {
  make: makeAgentRegistry,
}) {}
