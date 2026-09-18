/**
 * concurrency-pools.ts — pool admission for the agent manager.
 *
 * Two concurrency pools, never one, and one queue serving both:
 *
 * - Background (`maxBackground`) bounds detached agents.
 * - Foreground (`maxForeground`, `0` = unlimited) bounds agents a caller is
 *   blocking on inline.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself.
 *
 * These left `agent-manager.ts` together because they are one mechanism, not
 * five fields. The limits bound how many agents run, the counters count them,
 * and the queue holds the rest; every rule that matters is a relation between
 * them — a slot is taken before the first `await` so two spawns cannot both see
 * room, and given back on exactly one path — so splitting them up would let the
 * halves drift out of agreement. `agent-manager.ts`'s own hardest invariant
 * ("removing an entry from `queue` MUST release it") is enforced here, in
 * `remove`, for the same reason.
 *
 * What stayed in the manager: which pool a given spawn is charged to
 * (`poolFor`, which reads `AgentRecord` flags — nested children and detached
 * non-background spawns are charged to neither), and what happens to a queued
 * entry when it starts.
 */

/** Which concurrency pool a spawn is charged to. */
export type Pool = "background" | "foreground";

/** An entry waiting for a slot in its pool. */
export interface QueuedEntry {
  id: string;
  pool: Pool;
  /**
   * Start it. Never rejects — a startup failure lands on the record — and it
   * takes the pool slot synchronously before its first `await`.
   */
  start: () => Promise<void>;
  /**
   * Wake a caller blocked on this entry.
   *
   * Fired once `start` has SETTLED rather than at drain time: startup is async,
   * so releasing earlier would wake a `spawnAndWait` caller before
   * `record.promise` exists, and it would read a still-starting agent as one
   * that never ran.
   */
  release: () => void;
}

export class ConcurrencyPools {
  /** Background limit — how many detached agents may run at once. */
  maxBackground: number;
  /** Foreground limit. `0` = unlimited. */
  maxForeground: number;
  private runningBackground = 0;
  private runningForeground = 0;
  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `nextRunnable` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   */
  private queue: QueuedEntry[] = [];

  constructor(maxBackground: number, maxForeground: number) {
    this.maxBackground = maxBackground;
    this.maxForeground = maxForeground;
  }

  /** Whether `pool` has a free slot. An unlimited pool always does. */
  hasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxBackground
      : this.maxForeground === 0 || this.runningForeground < this.maxForeground;
  }

  /** Add an entry to the back of the waiting queue. */
  admit(entry: QueuedEntry): void {
    this.queue.push(entry);
  }

  /**
   * Charge a slot. `undefined` is charged to neither pool (nested children,
   * detached non-background spawns) and is a no-op.
   */
  acquire(pool: Pool | undefined): void {
    if (pool === "background") this.runningBackground++;
    else if (pool === "foreground") this.runningForeground++;
  }

  /** Give a slot back. Must be the pool the run was CHARGED TO, not a recomputed one. */
  release(pool: Pool | undefined): void {
    if (pool === "background") this.runningBackground--;
    else if (pool === "foreground") this.runningForeground--;
  }

  /**
   * Take the earliest queued entry whose own pool has room, or undefined when
   * none can start.
   *
   * Earliest eligible entry rather than `shift`: with one queue serving two
   * independent limits, a saturated foreground pool at the head would otherwise
   * stall every background agent behind it. FIFO within each pool is preserved.
   *
   * One entry per call, and the caller re-checks between calls — starting an
   * entry takes its slot synchronously, so "has room" is a moving target and a
   * batch take would over-start.
   */
  nextRunnable(): QueuedEntry | undefined {
    const i = this.queue.findIndex(e => this.hasRoom(e.pool));
    if (i === -1) return undefined;
    return this.queue.splice(i, 1)[0];
  }

  /**
   * Drop every queued entry `pred` accepts, releasing each one. The single
   * point that enforces "leaving the queue releases the waiter" — a missed
   * release is an unbounded hang, not a failed call.
   */
  remove(pred: (entry: QueuedEntry) => boolean): void {
    const kept: QueuedEntry[] = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /** The waiting entries, oldest first. */
  get queued(): readonly QueuedEntry[] {
    return this.queue;
  }

  /** How many entries of `pool` are waiting — the position `onQueued` reports. */
  queuedOn(pool: Pool): number {
    return this.queue.filter(e => e.pool === pool).length;
  }
}
