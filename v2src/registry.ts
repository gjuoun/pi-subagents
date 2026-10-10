import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FiberMap, Layer, Ref, SubscriptionRef } from "effect";
import { AgentNotFound } from "./errors.js";

/**
 * registry.ts — the one place the extension keeps its agents.
 *
 * Records (plain, published data) live in a SubscriptionRef the widget and the e2e
 * handle read; sessions live beside them in a Ref. The layer finalizer aborts any still
 * running child and disposes every child session, so runtime.dispose() on session_shutdown
 * is all the cleanup there is.
 */

export type AgentStatus = "running" | "done" | "error" | "aborted";

export interface AgentRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly status: AgentStatus;
  readonly runs: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly lastText: string;
  readonly toolUses: number;
  readonly lastTool?: string;
}

/** A child session held for the life of the runtime (so resume can reuse it). */
export interface AgentEntry {
  readonly session: AgentSession;
}

export interface RegistryShape {
  readonly agents: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, AgentRecord>>;
  readonly fibers: FiberMap.FiberMap<string, void, never>;
  readonly entries: Ref.Ref<ReadonlyMap<string, AgentEntry>>;
  readonly get: (id: string) => Effect.Effect<AgentRecord, AgentNotFound>;
  readonly list: Effect.Effect<ReadonlyArray<AgentRecord>>;
  readonly putRecord: (record: AgentRecord) => Effect.Effect<void>;
  readonly updateRecord: (id: string, f: (r: AgentRecord) => AgentRecord) => Effect.Effect<void>;
  readonly putEntry: (id: string, entry: AgentEntry) => Effect.Effect<void>;
  readonly getEntry: (id: string) => Effect.Effect<AgentEntry | undefined>;
}

export const Registry = Context.Service<RegistryShape>("pi-subagents/v2/Registry");

/** The cross-package handle the e2e harness reads (Symbol.for("pi-subagents:v2")). */
export const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");

export interface V2Handle {
  hasRunning(): boolean;
  waitForAll(): Promise<void>;
  list(): Array<AgentRecord>;
}

export interface RegistryOptions {
  /** Test/observability hook fired once when the layer scope closes. */
  readonly onDispose?: () => void;
}

export const layer = (options: RegistryOptions = {}): Layer.Layer<RegistryShape> =>
  Layer.effect(
    Registry,
    Effect.gen(function* () {
      const agents = yield* SubscriptionRef.make<ReadonlyMap<string, AgentRecord>>(new Map());
      const fibers = yield* FiberMap.make<string, void, never>();
      const entries = yield* Ref.make<ReadonlyMap<string, AgentEntry>>(new Map());

      const handle: V2Handle = {
        hasRunning: () =>
          Array.from(SubscriptionRef.getUnsafe(agents).values()).some((r) => r.status === "running"),
        waitForAll: async () => {
          while (handle.hasRunning()) await new Promise((resolve) => setTimeout(resolve, 10));
        },
        list: () => Array.from(SubscriptionRef.getUnsafe(agents).values()),
      };
      (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] = handle;

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          options.onDispose?.();
          const records = SubscriptionRef.getUnsafe(agents);
          const entryMap = yield* Ref.get(entries);
          yield* FiberMap.clear(fibers);
          yield* Effect.forEach(
            entryMap.entries(),
            ([id, entry]) =>
              Effect.sync(() => {
                if (records.get(id)?.status === "running") void entry.session.abort();
                entry.session.dispose();
              }),
            { discard: true },
          );
          if ((globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] === handle) {
            delete (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY];
          }
        }),
      );

      const updateMap = <V>(current: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => {
        const next = new Map(current);
        next.set(key, value);
        return next;
      };

      return {
        agents,
        fibers,
        entries,
        get: (id) =>
          SubscriptionRef.get(agents).pipe(
            Effect.flatMap((byId) => {
              const record = byId.get(id);
              return record === undefined
                ? Effect.fail(new AgentNotFound({ id }))
                : Effect.succeed(record);
            }),
          ),
        list: SubscriptionRef.get(agents).pipe(Effect.map((byId) => Array.from(byId.values()))),
        putRecord: (record) => SubscriptionRef.update(agents, (byId) => updateMap(byId, record.id, record)),
        updateRecord: (id, f) =>
          SubscriptionRef.update(agents, (byId) => {
            const current = byId.get(id);
            return current === undefined ? byId : updateMap(byId, id, f(current));
          }),
        putEntry: (id, entry) => Ref.update(entries, (byId) => updateMap(byId, id, entry)),
        getEntry: (id) => Ref.get(entries).pipe(Effect.map((byId) => byId.get(id))),
      } satisfies RegistryShape;
    }),
  );
