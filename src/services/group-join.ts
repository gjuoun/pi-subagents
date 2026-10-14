import { Context, Effect, FiberSet, Ref, type Scope } from "effect";
import { SubagentResultMessage } from "../domain/subagent-result.js";
import { ResultNotifier } from "./result-notifier.js";

/**
 * group-join.ts — the smart join: how background results reach the parent (JW-166).
 *
 * Background agents started by one parent turn's parallel Agent calls (same turn key, within
 * the batch window) form a group when there are two or more: one combined message when all finish, or a partial
 * one GROUP_TIMEOUT after the first completion, after which the rest regroup as stragglers on
 * STRAGGLER_TIMEOUT windows. A lone agent is announced on its own after a short hold. A result
 * read through get_subagent_result first (`consume`) is dropped from whatever is still pending.
 * Same timings as the v1 core's group-join.ts. Timers are Effect sleeps, so TestClock drives them.
 */

export const BATCH_WINDOW_MS = 100;
export const GROUP_TIMEOUT_MS = 30_000;
export const STRAGGLER_TIMEOUT_MS = 15_000;
export const SOLO_HOLD_MS = 200;

export interface GroupJoinShape {
  /**
   * A background agent was started (or queued) by an Agent call made in parent turn
   * `turnKey`. Calls from one turn batch together; a call from a new turn closes the batch.
   */
  readonly register: (id: string, turnKey?: string) => Effect.Effect<void>;
  /** Its result is ready to announce. */
  readonly settle: (id: string, message: SubagentResultMessage) => Effect.Effect<void>;
  /** Its result was read directly; never announce it. */
  readonly consume: (id: string) => Effect.Effect<void>;
  /** True while any result is held or a batch window is open (the e2e handle waits on it). */
  readonly pending: () => boolean;
}

interface Group {
  readonly ids: ReadonlySet<string>;
  readonly done: ReadonlyMap<string, SubagentResultMessage>;
  readonly straggler: boolean;
  /** Bumped to cancel a pending timeout. */
  readonly timer: number;
}

interface State {
  readonly batch: ReadonlyArray<string>;
  readonly batchKey: string | undefined;
  readonly batchToken: number;
  /** Results that arrived while their agent's batch window was still open. */
  readonly early: ReadonlyMap<string, SubagentResultMessage>;
  readonly groups: ReadonlyMap<number, Group>;
  readonly groupOf: ReadonlyMap<string, number>;
  readonly consumed: ReadonlySet<string>;
  readonly nextGroup: number;
  /** Solo results inside their hold. */
  readonly soloHeld: number;
}

const initial: State = {
  batch: [],
  batchKey: undefined,
  batchToken: 0,
  early: new Map(),
  groups: new Map(),
  groupOf: new Map(),
  consumed: new Set(),
  nextGroup: 1,
  soloHeld: 0,
};

const without = <K, V>(map: ReadonlyMap<K, V>, ...keys: K[]): ReadonlyMap<K, V> => {
  const next = new Map(map);
  for (const k of keys) next.delete(k);
  return next;
};
const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => new Map(map).set(key, value);

const makeGroupJoin: Effect.Effect<GroupJoinShape, never, Scope.Scope | ResultNotifier> = Effect.gen(function* () {
  const notifier = yield* ResultNotifier;
  const fibers = yield* FiberSet.make();
  const state = yield* Ref.make(initial);
  const fork = (effect: Effect.Effect<void>) => FiberSet.run(fibers, effect).pipe(Effect.asVoid);

  /** Send what is still unconsumed, as one message or a group. */
  const send = (items: ReadonlyArray<SubagentResultMessage>, partial: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { consumed } = yield* Ref.get(state);
      const live = items.filter((m) => !m.agentIds.some((id) => consumed.has(id)));
      if (live.length === 0) return;
      yield* notifier.deliver(live.length === 1 && !partial ? live[0] : SubagentResultMessage.group(live, partial));
    });

  const solo = (message: SubagentResultMessage): Effect.Effect<void> =>
    Ref.update(state, (s) => ({ ...s, soloHeld: s.soloHeld + 1 })).pipe(
      Effect.andThen(
        fork(
          Effect.sleep(SOLO_HOLD_MS).pipe(
            Effect.andThen(send([message], false)),
            Effect.ensuring(Ref.update(state, (s) => ({ ...s, soloHeld: s.soloHeld - 1 }))),
          ),
        ),
      ),
    );

  /** Arm a group's timeout; a later arm or a full delivery cancels it via the token. */
  const arm = (groupId: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const group = (yield* Ref.get(state)).groups.get(groupId);
      if (group === undefined) return;
      const token = group.timer + 1;
      yield* Ref.update(state, (s) => ({ ...s, groups: withEntry(s.groups, groupId, { ...group, timer: token }) }));
      const wait = group.straggler ? STRAGGLER_TIMEOUT_MS : GROUP_TIMEOUT_MS;
      yield* fork(Effect.sleep(wait).pipe(Effect.andThen(timeout(groupId, token))));
    });

  /** Partial delivery: announce what finished; the rest become stragglers. */
  const timeout = (groupId: number, token: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const group = (yield* Ref.get(state)).groups.get(groupId);
      if (group === undefined || group.timer !== token || group.done.size === 0) return;
      const delivered = [...group.done.values()];
      const remaining = new Set([...group.ids].filter((id) => !group.done.has(id)));
      yield* Ref.update(state, (s) => ({
        ...s,
        groupOf: without(s.groupOf, ...group.done.keys()),
        groups: withEntry(s.groups, groupId, { ids: remaining, done: new Map(), straggler: true, timer: token }),
      }));
      yield* send(delivered, true);
    });

  /** Feed one result into its group; deliver when the group is complete. */
  const intoGroup = (groupId: number, id: string, message: SubagentResultMessage): Effect.Effect<void> =>
    Effect.gen(function* () {
      const group = (yield* Ref.get(state)).groups.get(groupId);
      if (group === undefined) return yield* solo(message);
      const done = withEntry(group.done, id, message);
      if (done.size >= group.ids.size) {
        yield* Ref.update(state, (s) => ({
          ...s,
          groups: without(s.groups, groupId),
          groupOf: without(s.groupOf, ...group.ids),
        }));
        return yield* send([...done.values()], false);
      }
      yield* Ref.update(state, (s) => ({ ...s, groups: withEntry(s.groups, groupId, { ...group, done }) }));
      if (group.done.size === 0) yield* arm(groupId);
    });

  /** Close the batch window: 2+ agents become a group, else each is solo. */
  const closeBatch = (token: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(state);
      if (s.batchToken !== token) return;
      const ids = s.batch;
      const early = ids.flatMap((id) => {
        const m = s.early.get(id);
        return m === undefined ? [] : [[id, m] as const];
      });
      if (ids.length >= 2) {
        const groupId = s.nextGroup;
        yield* Ref.set(state, {
          ...s,
          batch: [],
          early: without(s.early, ...ids),
          nextGroup: groupId + 1,
          groups: withEntry(s.groups, groupId, { ids: new Set(ids), done: new Map(), straggler: false, timer: 0 }),
          groupOf: ids.reduce((m, id) => withEntry(m, id, groupId), s.groupOf),
        });
        for (const [id, m] of early) yield* intoGroup(groupId, id, m);
      } else {
        yield* Ref.set(state, { ...s, batch: [], early: without(s.early, ...ids) });
        for (const [, m] of early) yield* solo(m);
      }
    });

  return {
    register: (id, turnKey) =>
      Effect.gen(function* () {
        const open = yield* Ref.get(state);
        // A call from another turn ends the open batch now rather than joining it.
        if (open.batch.length > 0 && open.batchKey !== turnKey) yield* closeBatch(open.batchToken);
        const token = yield* Ref.modify(state, (s) => {
          const next = s.batchToken + 1;
          return [next, { ...s, batch: [...s.batch, id], batchKey: turnKey, batchToken: next }] as const;
        });
        yield* fork(Effect.sleep(BATCH_WINDOW_MS).pipe(Effect.andThen(closeBatch(token))));
      }),
    settle: (id, message) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state);
        if (s.batch.includes(id)) {
          yield* Ref.set(state, { ...s, early: withEntry(s.early, id, message) });
          return;
        }
        const groupId = s.groupOf.get(id);
        if (groupId !== undefined) return yield* intoGroup(groupId, id, message);
        yield* solo(message);
      }),
    consume: (id) => Ref.update(state, (s) => ({ ...s, consumed: new Set(s.consumed).add(id) })),
    pending: () => {
      const s = Ref.getUnsafe(state);
      return s.batch.length > 0 || s.early.size > 0 || s.soloHeld > 0 || [...s.groups.values()].some((g) => g.ids.size > 0);
    },
  } satisfies GroupJoinShape;
});

export class GroupJoin extends Context.Service<GroupJoin>()("pi-subagents/v2/GroupJoin", {
  make: makeGroupJoin,
}) {}
