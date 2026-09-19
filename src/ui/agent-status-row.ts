/**
 * agent-status-row.ts — owns the extension status row: the status text, the turn-based
 * aging of finished marks, and the clock.
 *
 * The clock has exactly two jobs — cycling the running marks' glyph and playing out a
 * finishing mark's pop — so it runs only while there is something to animate (a RUNNING or
 * QUEUED mark, or a finish pop still owed, which has to outlive its run), a frame identical
 * to the last one is not written so an idle row costs nothing, and finished marks stay
 * solid until `onTurnStart()` ages them out, with errors lingering an extra turn so a
 * failure is not missed. Those guards are load-bearing rather than nice to have: in pi-web
 * every `setStatus` is an event that re-renders the chat.
 *
 * What a cycling mark looks like is `RUN_PHASE_GLYPHS` in `agent-marks.ts` — one
 * exported table, swappable without touching this file, the clock rule or the tests.
 */
import {
  type ColorResolver,
  formatAgentStatusLine,
  RUN_PHASE_GLYPHS,
  type StatusAgent,
  type StatusPhase,
} from "./agent-marks.js";

const STATUS_KEY = "subagents";
/** Cycle cadence: one glyph per beat, so a full four-frame cycle is 2.4 s. */
const BLINK_MS = 600;
/** Beats a finish pop burns for: two frames, ~1.2 s, then the mark settles back to steady. */
const POP_FRAMES = 2;
/** How many turns a completed mark stays solid before it drops. */
const FINISHED_LINGER_TURNS = 1;
/** A failure lingers one turn longer, so it cannot be missed between repaints. */
const ERROR_LINGER_TURNS = 2;
const ERROR_STATUSES: ReadonlySet<string> = new Set(["error", "aborted", "stopped"]);

/** The slice of `ctx.ui` this unit needs. */
export interface StatusSink {
  setStatus(key: string, text: string | undefined): void;
}

/** Injectable clock, so the beat cadence is provable without waiting on one. */
export interface StatusClock {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AgentStatusBarDeps {
  /** Top-level agents in spawn order. Filtering is the caller's job. */
  listAgents: () => readonly StatusAgent[];
  /** Defaults to the agent type's configured colour. */
  resolveColor?: ColorResolver;
  /** Defaults to the real timers. */
  clock?: StatusClock;
}

const realClock: StatusClock = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class AgentStatusBar {
  private ctx: StatusSink | undefined;
  private handle: unknown;
  private phase: StatusPhase = 0;
  /** Last written text, including `undefined` — the dedupe that keeps an idle row silent. */
  private last: string | undefined;
  private wrote = false;
  /** Turn age of each finished mark, keyed by agent id. */
  private readonly finishedAge = new Map<string, number>();
  /** Beats of finish pop still owed, keyed by agent id. Deleted the beat it reaches zero. */
  private readonly pop = new Map<string, number>();
  /**
   * Frames of cycle lag per agent id — the cascade that makes the running marks travel left to
   * right instead of flashing together. Assigned once, on an id's first render, and keyed by the id
   * and never by its position in the row: a position-derived lag would re-phase every later mark
   * the moment an earlier one aged out or finished, which reads as a glitch rather than a wave.
   */
  private readonly offsets = new Map<string, number>();
  /**
   * Slots handed out so far, monotonic on purpose: an agent that starts after an older one has
   * finished takes the next slot in the wave rather than the freed one, so the cascade carries on
   * where it was instead of resetting.
   */
  private assignedOffsets = 0;

  constructor(private readonly deps: AgentStatusBarDeps) {}

  setUICtx(ctx: StatusSink): void {
    if (ctx === this.ctx) return;
    this.ctx = ctx;
    // A different context has never been told anything: force the next update through.
    this.last = undefined;
    this.wrote = false;
    this.update();
  }

  /** An agent started. The manager already reports `running`; this repaints and arms the clock. */
  markRunning(_id: string): void {
    this.update();
  }

  /**
   * An agent settled. Its mark pops for `POP_FRAMES` beats and then stays solid until the turn ages
   * it out — which means the clock has to outlive the run it was armed for.
   */
  markFinished(id: string): void {
    if (!this.finishedAge.has(id)) this.finishedAge.set(id, 0);
    this.pop.set(id, POP_FRAMES);
    this.update();
  }

  /** A new turn: age every finished mark so an old run stops owning the row. */
  onTurnStart(): void {
    for (const [id, age] of this.finishedAge) this.finishedAge.set(id, age + 1);
    this.update();
  }

  /** Kept for the call sites the widget had; `update()` is the real owner of the clock. */
  ensureTimer(): void {
    this.update();
  }

  update(): void {
    const rows = this.rows();
    // Anything worth animating keeps the clock alive: a cycling mark, a queued one that may start
    // next beat, or a pop still owed by a mark that has already settled. An idle row keeps it
    // off — an always-on tick is what made the TUI and pi-web fight over redraws.
    const animating = this.pop.size > 0
      || rows.some((row) => row.status === "running" || row.status === "queued");
    this.syncClock(animating);
    this.assignOffsets(rows);

    const text = formatAgentStatusLine(rows, this.phase, this.deps.resolveColor, this.pop, this.offsets);
    if (this.wrote && text === this.last) return;
    this.last = text;
    this.wrote = true;
    this.ctx?.setStatus(STATUS_KEY, text === "" ? undefined : text);
  }

  dispose(): void {
    this.syncClock(false);
    this.ctx?.setStatus(STATUS_KEY, undefined);
    this.finishedAge.clear();
    this.pop.clear();
    this.offsets.clear();
    this.ctx = undefined;
    this.last = undefined;
    this.wrote = false;
  }

  private syncClock(on: boolean): void {
    const clock = this.deps.clock ?? realClock;
    if (on && this.handle === undefined) {
      this.handle = clock.set(() => this.tick(), BLINK_MS);
    } else if (!on && this.handle !== undefined) {
      clock.clear(this.handle);
      this.handle = undefined;
    }
  }

  private tick(): void {
    this.phase = ((this.phase + 1) % 4) as StatusPhase;
    for (const [id, beats] of this.pop) {
      if (beats <= 1) this.pop.delete(id);
      else this.pop.set(id, beats - 1);
    }
    this.update();
  }

  /**
   * Hand each mark its place in the cascade, in the order the row shows them, and forget the marks
   * that are no longer in the row.
   *
   * Slots are assigned once per id and wrapped to the cycle, so a fifth mark restarts the pattern
   * rather than running off the table. The counter behind them only ever climbs: pruning a departed
   * mark's entry keeps the map honest without letting the next new agent step into a slot that the
   * wave has already passed. The glyph count is the one thing read from the table — the characters
   * themselves stay the look's business, so swapping them still needs no edit here.
   */
  private assignOffsets(rows: readonly StatusAgent[]): void {
    const live = new Set(rows.map((row) => row.id));
    for (const id of [...this.offsets.keys()]) if (!live.has(id)) this.offsets.delete(id);
    for (const row of rows) {
      if (this.offsets.has(row.id)) continue;
      this.offsets.set(row.id, this.assignedOffsets % RUN_PHASE_GLYPHS.length);
      this.assignedOffsets += 1;
    }
  }

  /** The agents worth a mark right now, in the caller's order. */
  private rows(): StatusAgent[] {
    const out: StatusAgent[] = [];
    for (const agent of this.deps.listAgents()) {
      if (agent.status === "running" || agent.status === "queued") {
        out.push(agent);
        continue;
      }
      const age = this.finishedAge.get(agent.id);
      if (age === undefined) continue;
      const maxAge = ERROR_STATUSES.has(agent.status) ? ERROR_LINGER_TURNS : FINISHED_LINGER_TURNS;
      if (age < maxAge) out.push(agent);
    }
    return out;
  }
}
