import { Context, Effect, FiberMap, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { Agent, type AgentSnapshot } from "../domain/agent.js";
import type { AgentType } from "../domain/agent-type.js";
import { type AgentNotFound, RegistryError, renderSessionError, type SessionError, type V2Error } from "../domain/errors.js";
import type { ForkSource } from "../domain/fork.js";
import { assignHandle, handleBase } from "../domain/handle.js";
import { SubagentResultMessage } from "../domain/subagent-result.js";
import { GroupJoin } from "./group-join.js";
import { IdGenerator } from "./id-generator.js";
import { ParentContext } from "./parent-context.service.js";
import { SessionFactory } from "./session-factory.js";
import { Settings } from "./settings.js";

/**
 * agent-registry.ts — the one place the extension keeps its agents.
 *
 * Snapshots (plain, published data) live in a SubscriptionRef the widget and the e2e handle
 * read; the Agent objects live beside them in a Ref. The layer finalizer aborts any still
 * running child and disposes every one, so runtime.dispose() on session_shutdown is all the
 * cleanup there is.
 *
 * AgentRegistry is a class service built by its own `make`: the constructor declares its
 * dependencies (SessionFactory, GroupJoin, IdGenerator, Settings) instead of an options bag.
 */

/** Per-call choices from the Agent tool. Frontmatter wins for model/thinking; these fill gaps. */
export interface CreateOptions {
  readonly model?: string;
  readonly thinking?: string;
  /** Display name; defaults to the type name. */
  readonly name?: string;
  /** Branch the parent's conversation (subagent_type "fork"). */
  readonly fork?: ForkSource;
}

export interface AgentRegistryShape {
  /** Spawn a child session and register a fresh agent for it. */
  readonly create: (
    type: AgentType,
    description: string,
    options?: CreateOptions,
  ) => Effect.Effect<Agent, SessionError, ParentContext>;
  /** Look an agent up by id or handle. */
  readonly find: (ref: string) => Effect.Effect<Agent, AgentNotFound>;
  /** Wait until the agent is neither queued nor running. */
  readonly awaitSettled: (agent: Agent) => Effect.Effect<AgentSnapshot>;
  /** The agent's result was read directly: never announce it. */
  readonly consume: (id: string) => Effect.Effect<void>;
  /**
   * Run detached. Takes a background pool slot (`maxConcurrent`); with none free the agent
   * waits as `queued` and starts in FIFO order as slots free up.
   */
  readonly runInBackground: (agent: Agent, prompt: string) => Effect.Effect<string, V2Error, ParentContext>;
  readonly snapshots: Effect.Effect<ReadonlyArray<AgentSnapshot>>;
  readonly changes: Stream.Stream<ReadonlyArray<AgentSnapshot>>;
  /** A synchronous view of the snapshot map (the e2e handle reads it). */
  readonly list: () => ReadonlyArray<AgentSnapshot>;
  readonly hasRunning: () => boolean;
}

/** The background pool: running count plus the FIFO of starts waiting for a slot. */
interface PoolState {
  readonly active: number;
  readonly waiting: ReadonlyArray<Effect.Effect<void>>;
}

const updateMap = <V>(current: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => {
  const next = new Map(current);
  next.set(key, value);
  return next;
};

/** The dependency constructor: declares SessionFactory, GroupJoin, IdGenerator and Settings. */
const makeAgentRegistry: Effect.Effect<
  AgentRegistryShape,
  never,
  Scope.Scope | SessionFactory | GroupJoin | IdGenerator | Settings
> = Effect.gen(function* () {
  const factory = yield* SessionFactory;
  const join = yield* GroupJoin;
  const ids = yield* IdGenerator;
  const settings = yield* Settings;
  const pool = yield* Ref.make<PoolState>({ active: 0, waiting: [] });
  const snapshots = yield* SubscriptionRef.make<ReadonlyMap<string, AgentSnapshot>>(new Map());
  const fibers = yield* FiberMap.make<string, void, never>();
  const agents = yield* Ref.make<ReadonlyMap<string, Agent>>(new Map());

  const list = (): ReadonlyArray<AgentSnapshot> => Array.from(SubscriptionRef.getUnsafe(snapshots).values());
  const hasRunning = (): boolean => list().some((s) => s.status === "running" || s.status === "queued");

  const publish = (snapshot: AgentSnapshot): Effect.Effect<void> =>
    SubscriptionRef.update(snapshots, (byId) => updateMap(byId, snapshot.id, snapshot));

  const deliver = (agent: Agent, status: "done" | "error" | "aborted", body: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const snapshot = yield* agent.snapshot;
      yield* join.settle(agent.id, SubagentResultMessage.fromAgent(snapshot, status, body));
    });

  /** Give a finished run's slot to the next waiting start, or free it. */
  const releaseSlot: Effect.Effect<void> = Effect.flatten(
    Ref.modify(pool, (p: PoolState): readonly [Effect.Effect<void>, PoolState] => {
      const [next, ...rest] = p.waiting;
      return next === undefined
        ? [Effect.void, { active: p.active - 1, waiting: [] }]
        : [next, { active: p.active, waiting: rest }];
    }),
  );

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
    create: (type, description, options) =>
      Effect.gen(function* () {
        const id = yield* ids.next();
        const session = yield* factory.open({
          id,
          type: type.name,
          systemPrompt: type.systemPrompt,
          tools: type.tools,
          model: type.model ?? options?.model,
          thinking: type.thinking ?? options?.thinking,
          skills: type.skills,
          maxTurns: type.maxTurns,
          ...(options?.fork !== undefined && { fork: options.fork }),
        });
        const name = options?.name ?? type.name;
        const taken = new Set([...(yield* Ref.get(agents)).values()].map((a) => a.handle));
        const handle = assignHandle(handleBase(name), taken);
        const agent = yield* Agent.make({ id, type: type.name, name, handle, description, color: type.color, session, publish });
        yield* Ref.update(agents, (byId) => updateMap(byId, id, agent));
        return agent;
      }),
    find: (ref) =>
      Ref.get(agents).pipe(
        Effect.flatMap((byId) => {
          const agent = byId.get(ref) ?? [...byId.values()].find((a) => a.handle === ref.toLowerCase());
          return agent === undefined ? Effect.fail(RegistryError.AgentNotFound({ id: ref })) : Effect.succeed(agent);
        }),
      ),
    awaitSettled: (agent) =>
      SubscriptionRef.changes(snapshots).pipe(
        Stream.map((byId) => byId.get(agent.id)),
        Stream.filter((s): s is AgentSnapshot => s !== undefined && s.status !== "running" && s.status !== "queued"),
        Stream.runHead,
        Effect.flatMap((found) => (found._tag === "Some" ? Effect.succeed(found.value) : agent.snapshot)),
      ),
    consume: (id) => join.consume(id),
    runInBackground: (agent, prompt) =>
      Effect.gen(function* () {
        const current = yield* agent.snapshot;
        if ((yield* agent.isRunning) || current.status === "queued") {
          return yield* Effect.fail(RegistryError.AgentBusy({ id: agent.id, name: agent.name }));
        }
        yield* join.register(agent.id, (yield* ParentContext).turnKey);
        const limit = yield* settings.maxConcurrent;
        // One start: run, deliver, then hand the slot to the next waiting start.
        const start: Effect.Effect<void> = FiberMap.run(
          fibers,
          agent.id,
          agent.run(prompt).pipe(
            Effect.tap((answer) =>
              Effect.flatMap(agent.snapshot, (s) => deliver(agent, s.status === "aborted" ? "aborted" : "done", answer)),
            ),
            Effect.catchTag("RunFailed", (error) => deliver(agent, "error", renderSessionError(error))),
            Effect.catchTag("AgentBusy", () => Effect.void),
            Effect.ensuring(releaseSlot),
          ),
        ).pipe(Effect.asVoid);
        const admitted = yield* Ref.modify(pool, (p) =>
          p.active < limit ? [true, { ...p, active: p.active + 1 }] : [false, { ...p, waiting: [...p.waiting, start] }],
        );
        if (admitted) yield* start;
        else yield* agent.markQueued();
        const snapshot = yield* agent.snapshot;
        return admitted
          ? `Started ${snapshot.type} (id ${snapshot.id}) in the background — its result will arrive as a message.`
          : `Queued ${snapshot.type} (id ${snapshot.id}): all background slots are busy; it starts when one frees up and its result will arrive as a message.`;
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
