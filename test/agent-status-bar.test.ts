import { describe, expect, it } from "vitest";
import { AgentStatusBar, type StatusClock } from "../src/ui/agent-status-bar.js";
import {
  formatAgentStatusLine,
  type StatusAgent,
  type StatusPhase,
} from "../src/ui/agent-status-line.js";

const AMBER = "#FFC800";
/** The cadence the row is built on: a 4-frame glyph cycle of 600 ms beats is 2.4 s. */
const BLINK_MS = 600;

const running = (id = "a1", type = "finder"): StatusAgent => ({ id, type, status: "running" });
const queued = (id = "q1", type = "finder"): StatusAgent => ({ id, type, status: "queued" });
const completed = (id = "a1", type = "finder"): StatusAgent => ({ id, type, status: "completed" });

/**
 * Every expected frame is derived from the line module's own animation rather than written out
 * again here. What a frame looks like is pinned by `agent-status-line.test.ts` (its literal table is
 * where a new animation gets recorded); this file proves only the plumbing around it — which phase
 * is current, how long a pop burns, and when the clock runs — so replacing `RUN_PHASE_GLYPHS`
 * needs no edit in this file and none to the clock rule.
 */
const PHASES: readonly StatusPhase[] = [0, 1, 2, 3];
const amber = () => AMBER;
/** One cycle: the glyph each phase draws for a running mark. */
const CYCLE = PHASES.map((phase) => formatAgentStatusLine([running()], phase, amber));
/** A pop as the bar arms it — open on the finish beat, then the tick after it — and the steady frame. */
const popping = (id: string, beats: number) => new Map([[id, beats]]);
const POP_FRAME = formatAgentStatusLine([completed()], 0, amber, popping("a1", 2));
const POP_LIGHT_FRAME = formatAgentStatusLine([completed()], 0, amber, popping("a1", 1));
const STEADY_FRAME = formatAgentStatusLine([completed()], 0, amber);
const HOLLOW_FRAME = formatAgentStatusLine([queued()], 0, amber);
/** The tick count the phase-sequence test drives. */
const TICKS = 8;
/**
 * How many of those ticks actually change the frame — a cycle with two equal frames draws fewer,
 * because the bar writes only on a change.
 */
const DRAWN_TICKS = Array.from({ length: TICKS }, (_, i) => i + 1).filter(
  (tick) => CYCLE[tick % 4] !== CYCLE[(tick - 1) % 4],
).length;

/**
 * The row the bar should draw, again derived rather than written out: `agent-status-line.test.ts`
 * owns what a cascade looks like, this file proves only which slot each mark was given.
 */
const cascade = (agents: readonly StatusAgent[], phase: StatusPhase, lags: Record<string, number>) =>
  formatAgentStatusLine(agents, phase, amber, new Map(), new Map(Object.entries(lags)));
/** A written row with the SGR stripped — the glyphs, one per mark, in row order. */
const glyphsOf = (text: string | undefined) => (text ?? "").replace(/\u001b\[[0-9;]*m/g, "");

/** Records what was asked of the clock, and lets a test fire the tick by hand. */
function fakeClock() {
  const set: number[] = [];
  const ms: number[] = [];
  const clear: unknown[] = [];
  let tick: (() => void) | undefined;
  const clock: StatusClock = {
    set(fn, interval) { set.push(set.length + 1); ms.push(interval); tick = fn; return set.length; },
    clear(handle) { clear.push(handle); tick = undefined; },
  };
  return { clock, set, ms, clear, fire: () => tick?.() };
}

function harness(agents: StatusAgent[]) {
  const writes: Array<string | undefined> = [];
  const { clock, ...rest } = fakeClock();
  const bar = new AgentStatusBar({
    listAgents: () => agents,
    resolveColor: amber,
    clock,
  });
  bar.setUICtx({ setStatus: (_key, text) => writes.push(text) });
  return { bar, writes, ...rest };
}

describe("AgentStatusBar", () => {
  it("writes one mark per agent: the cycling glyph for running, the hollow one for queued", () => {
    const { writes } = harness([running(), queued()]);
    expect(writes.at(-1)).toBe(`${CYCLE[0]}${HOLLOW_FRAME}`);
  });

  it("hands each running mark the next slot in the cascade, in first-render order", () => {
    const agents = [running("a1"), running("a2"), running("a3")];
    const h = harness(agents);
    const lags = { a1: 0, a2: 1, a3: 2 };

    expect(h.writes.at(-1)).toBe(cascade(agents, 0, lags));
    // the row read out: each mark one frame further back than the one before, so it travels
    expect(glyphsOf(h.writes.at(-1))).toBe("▪■□");

    // it stays one row beating together: the head advances a frame and the rest stay one behind
    h.fire();
    expect(h.writes.at(-1)).toBe(cascade(agents, 1, lags));
    expect(glyphsOf(h.writes.at(-1))).toBe("■▪■");
  });

  it("keeps the surviving marks' frames when the earliest one leaves the row", () => {
    const agents = [running("a1"), running("a2"), running("a3")];
    const h = harness(agents);
    const before = glyphsOf(h.writes.at(-1));
    expect(before).toBe("▪■□");

    agents.splice(0, 1);
    h.bar.update();

    // exactly the frames they were already showing, minus the mark that left
    expect(glyphsOf(h.writes.at(-1))).toBe(before.slice(1));
    expect(h.writes.at(-1)).toBe(cascade(agents, 0, { a2: 1, a3: 2 }));
    // and the offset really is keyed by id: re-slotted by position, a2 would have taken the head's
    // frame and both marks would have jumped — the glitch this test exists to pin
    expect(cascade(agents, 0, { a2: 0, a3: 1 })).not.toBe(h.writes.at(-1));
    expect(glyphsOf(cascade(agents, 0, { a2: 0, a3: 1 }))).toBe("▪■");
  });

  it("gives a newly started agent the next slot, not the one a departed mark freed", () => {
    const agents = [running("a1"), running("a2"), running("a3")];
    const h = harness(agents);

    agents.splice(0, 1); // a1 leaves: slot 0 is free
    agents.push(running("a4")); // a4 must not take it
    h.bar.update();

    expect(h.writes.at(-1)).toBe(cascade(agents, 0, { a2: 1, a3: 2, a4: 3 }));
    expect(glyphsOf(h.writes.at(-1))).toBe("■□■");
  });

  it("wraps the cascade after a full cycle of marks", () => {
    const agents = ["a1", "a2", "a3", "a4", "a5"].map((id) => running(id));
    const h = harness(agents);

    // the fifth mark restarts the pattern rather than running off the table
    expect(h.writes.at(-1)).toBe(cascade(agents, 0, { a1: 0, a2: 1, a3: 2, a4: 3, a5: 0 }));
    expect(glyphsOf(h.writes.at(-1))).toBe("▪■□■▪");
  });

  it("forgets a departed mark's slot, so it re-enters as a new mark", () => {
    const agents = [running("a1"), running("a2")];
    const h = harness(agents);

    agents.splice(0, 1); // a1 leaves and is pruned
    agents.push(running("a3")); // takes slot 2
    h.bar.update();
    agents.push(running("a1")); // a1 comes back: a genuinely new mark again
    h.bar.update();

    expect(h.writes.at(-1)).toBe(cascade(agents, 0, { a2: 1, a3: 2, a1: 3 }));
    // a slot that had been kept alive would have left a1 on the head's frame instead
    expect(cascade(agents, 0, { a1: 0, a2: 1, a3: 2 })).not.toBe(h.writes.at(-1));
  });

  it("still arms one clock for a two-mark cascade, and stops it once both marks are gone", () => {
    const agents = [running("a1"), running("a2")];
    const h = harness(agents);

    expect(h.set).toEqual([1]); // one clock for the row, not one per mark
    expect(h.ms).toEqual([BLINK_MS]);
    h.fire();
    expect(h.set.length).toBe(1);

    agents.splice(0, 2);
    h.bar.update();
    expect(h.clear.length).toBe(1);
  });

  it("does not emit a second time when the frame is identical", () => {
    const h = harness([running()]);
    const before = h.writes.length;
    h.bar.update();
    expect(h.writes.length).toBe(before);
  });

  it("visits 0→1→2→3→0 over four ticks, and wraps round into a second cycle", () => {
    const h = harness([running()]);
    expect(h.writes.at(-1)).toBe(CYCLE[0]);

    // Two full cycles: every tick lands on its phase's frame, and the fourth wraps back to the first.
    const seen: string[] = [];
    for (let tick = 0; tick < TICKS; tick++) {
      h.fire();
      seen.push(h.writes.at(-1) ?? "");
    }
    expect(seen).toEqual([
      CYCLE[1], CYCLE[2], CYCLE[3], CYCLE[0],
      CYCLE[1], CYCLE[2], CYCLE[3], CYCLE[0],
    ]);
    // every tick drew the frame its phase owns, and only the changed ones were written
    expect(h.writes.length).toBe(1 + DRAWN_TICKS);
    // four phases, three shapes: the cycle never collapses onto a two-frame toggle
    expect(new Set(CYCLE).size).toBe(3);
    expect(CYCLE[1]).toBe(CYCLE[3]);
    // and no two consecutive frames are the same shape, so every beat of the row moves
    for (let phase = 0; phase < PHASES.length; phase++) {
      expect(CYCLE[phase]).not.toBe(CYCLE[(phase + 1) % PHASES.length]);
    }
  });

  it("pops a finished agent for exactly two frames — both drawn — then leaves it steady", () => {
    const agents: StatusAgent[] = [running()];
    const h = harness(agents);

    agents.splice(0, 1, completed());
    h.bar.markFinished("a1");
    expect(h.writes.at(-1)).toBe(POP_FRAME);

    h.fire();
    expect(h.writes.at(-1)).toBe(POP_LIGHT_FRAME);
    h.fire();
    expect(h.writes.at(-1)).toBe(STEADY_FRAME);
    // four writes: the running frame, the pop's two frames, the settled one. Unlike the old
    // luminance flash — whose second beat was deduped because it drew the same frame — both pop
    // frames are distinct renders, and the pop is two of them, not three.
    expect(h.writes).toEqual([CYCLE[0], POP_FRAME, POP_LIGHT_FRAME, STEADY_FRAME]);
    expect(POP_FRAME).not.toBe(POP_LIGHT_FRAME);
    // the pop keeps the settled glyph: the change is a background, not a shape
    expect(POP_FRAME).toContain("48;2;");
    expect(POP_FRAME.replace(/\u001b\[[0-9;]*m/g, "")).toBe(STEADY_FRAME.replace(/\u001b\[[0-9;]*m/g, ""));
  });

  it("keeps the clock on while a pop is pending and stops it once it expires", () => {
    const agents: StatusAgent[] = [running()];
    const h = harness(agents);
    expect(h.set).toEqual([1]);
    expect(h.ms).toEqual([BLINK_MS]);

    agents.splice(0, 1, completed());
    h.bar.markFinished("a1");
    expect(h.clear.length).toBe(0);
    h.fire();
    expect(h.clear.length).toBe(0);
    h.fire();
    expect(h.clear.length).toBe(1);
    expect(h.writes.at(-1)).toBe(STEADY_FRAME);
  });

  it("arms the clock for a finish pop even when nothing was running", () => {
    const agents: StatusAgent[] = [];
    const h = harness(agents);
    expect(h.set.length).toBe(0);

    agents.push(completed());
    h.bar.markFinished("a1");
    expect(h.set.length).toBe(1);
    expect(h.writes.at(-1)).toBe(POP_FRAME);
    h.fire();
    expect(h.clear.length).toBe(0);
    h.fire();
    expect(h.clear.length).toBe(1);
  });

  it("arms the clock while something is queued, and writes one steady frame", () => {
    const h = harness([queued()]);
    expect(h.set.length).toBe(1);
    expect(h.writes).toEqual([HOLLOW_FRAME]);
  });

  it("arms no clock at all while the bar is idle", () => {
    const h = harness([]);
    expect(h.set.length).toBe(0);
    expect(h.clear.length).toBe(0);
    expect(h.writes).toEqual([undefined]);

    h.bar.update();
    expect(h.set.length).toBe(0);
    // nothing to say twice: the idle row is silent, not a redraw loop
    expect(h.writes.length).toBe(1);
  });

  it("drops a finished mark at the next turn, clearing the status with it", () => {
    const agents: StatusAgent[] = [running()];
    const h = harness(agents);
    agents.splice(0, 1, completed());
    h.bar.markFinished("a1");
    h.bar.onTurnStart();
    expect(h.writes.at(-1)).toBeUndefined();

    // the pop it was still owed burns off without reviving the row
    h.fire();
    h.fire();
    expect(h.writes.at(-1)).toBeUndefined();
    expect(h.clear.length).toBe(1);
  });

  it("clears the status on dispose", () => {
    const h = harness([queued()]);
    h.bar.dispose();
    expect(h.writes.at(-1)).toBeUndefined();
    expect(h.clear.length).toBe(1);
  });
});
