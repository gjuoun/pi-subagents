/**
 * agent-status-bar.ts — owns the extension status row.
 *
 * What survives of `AgentWidget` once the above-editor widget is gone: the status text, the
 * turn-based aging of finished marks, and the clock. The widget's 80 ms timer existed to animate a
 * spinner; here the only reason to tick at all is the running marks' blink, so:
 *
 *   - the clock runs only while something is RUNNING (queued and finished marks are steady),
 *   - a frame identical to the last one is not written, so an idle row costs nothing,
 *   - finished marks stay solid until `onTurnStart()` ages them out — the same 'one turn' rule the
 *     widget used, with errors lingering an extra turn so a failure is not missed.
 *
 * In pi-web every `setStatus` is an event that re-renders the chat, which is exactly why the two
 * guards above are load-bearing rather than nice to have.
 */
import {
  type ColorResolver,
  formatAgentStatusLine,
  type StatusAgent,
  type StatusPhase,
} from "./agent-status-line.js";

const STATUS_KEY = "subagents";
/** Blink cadence. Fast enough to read as blinking, slow enough to stay cheap in the browser. */
const BLINK_MS = 600;
/** How many turns a completed mark stays solid before it drops. */
const FINISHED_LINGER_TURNS = 1;
/** A failure lingers one turn longer, so it cannot be missed between repaints. */
const ERROR_LINGER_TURNS = 2;
const ERROR_STATUSES: ReadonlySet<string> = new Set(["error", "aborted", "stopped"]);

/** The slice of `ctx.ui` this unit needs. */
export interface StatusSink {
  setStatus(key: string, text: string | undefined): void;
}

/** Injectable clock, so the blink cadence is provable without waiting on one. */
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

  /** An agent settled. Its mark stays solid until the turn ages it out. */
  markFinished(id: string): void {
    if (!this.finishedAge.has(id)) this.finishedAge.set(id, 0);
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
    const running = rows.some((row) => row.status === "running");
    this.syncClock(running);

    const text = formatAgentStatusLine(rows, this.phase, this.deps.resolveColor);
    if (this.wrote && text === this.last) return;
    this.last = text;
    this.wrote = true;
    this.ctx?.setStatus(STATUS_KEY, text === "" ? undefined : text);
  }

  dispose(): void {
    this.syncClock(false);
    this.ctx?.setStatus(STATUS_KEY, undefined);
    this.finishedAge.clear();
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
    this.phase = this.phase === 0 ? 1 : 0;
    this.update();
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
