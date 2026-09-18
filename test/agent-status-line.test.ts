import { describe, expect, it } from "vitest";
import {
  formatAgentStatusLine,
  RUN_PHASE_GLYPHS,
  type StatusAgent,
  type StatusPhase,
} from "../src/ui/agent-status-line.js";

const amber = () => "#FFC800";
const cyan = () => "#00C8FF";
const uncolored = () => undefined;
const byType = (colors: Record<string, string>) => (type: string | undefined) =>
  (type ? colors[type] : undefined);

const agent = (type: string, status: StatusAgent["status"]): StatusAgent => ({
  id: `${type}-${status}`,
  type,
  status,
});
const running = (type = "finder") => agent(type, "running");

const PHASES: readonly StatusPhase[] = [0, 1, 2, 3];
/** Nothing is popping. */
const NO_POP: ReadonlyMap<string, number> = new Map();
/** Beats of pop still owed on the finish beat, and on the tick after it (the bar arms two). */
const POP_OPEN = 2;
const POP_SECOND = 1;

/**
 * One running amber (#FFC800) mark, as it renders at each phase of the glyph cycle.
 *
 * Written out rather than recomputed from `RUN_PHASE_GLYPHS`, so this is the file that pins what the
 * animation actually looks like — and therefore the only test file a new look has to be recorded in.
 * The bar's own suite derives every frame from the exported table and needs no edit.
 */
const AMBER_CYCLE = [
  "\u001b[38;2;255;200;0m▪\u001b[39m",
  "\u001b[38;2;255;200;0m■\u001b[39m",
  "\u001b[38;2;255;200;0m□\u001b[39m",
  "\u001b[38;2;255;200;0m■\u001b[39m",
] as const;
/** Settled: the dense square the pop cut out, no background, no dimming. */
const AMBER_STEADY = "\u001b[38;2;255;200;0m▓\u001b[39m";
/** Waiting: the small hollow square, greyed by SGR 2 rather than by a different geometry. */
const AMBER_QUEUED = "\u001b[2m\u001b[38;2;255;200;0m▫\u001b[39m\u001b[22m";
/** The pop, frame one: a black square cut out of the agent's own colour, used as a background. */
const AMBER_POP = "\u001b[38;2;0;0;0m\u001b[48;2;255;200;0m▓\u001b[49m\u001b[39m";
/** Frame two: the same square on that colour lightened half-way to white. */
const AMBER_POP_LIGHT = "\u001b[38;2;0;0;0m\u001b[48;2;255;228;128m▓\u001b[49m\u001b[39m";
const SGR = /\u001b\[[0-9;]*m/g;

/**
 * The cascade the bar hands the formatter: a frame of lag per agent id. Derived from
 * `RUN_PHASE_GLYPHS` the way the bar derives every frame it expects, so this file's literal tables
 * stay the only place the look is written out.
 */
const offsetsOf = (lags: Record<string, number>) => new Map(Object.entries(lags));
/** The phase a mark at `offset` frames of lag is drawing when the head is at `phase`. */
const laggedPhase = (phase: StatusPhase, offset: number): StatusPhase =>
  ((((phase - offset) % RUN_PHASE_GLYPHS.length) + RUN_PHASE_GLYPHS.length) % RUN_PHASE_GLYPHS.length) as StatusPhase;

/** The colour a rendered mark was painted with on `layer` (38 = foreground, 48 = background). */
function channels(mark: string, layer: 38 | 48): number[] {
  const match = new RegExp(`${layer};2;(\\d+);(\\d+);(\\d+)`).exec(mark);
  if (!match) throw new Error(`no truecolor ${layer} in ${JSON.stringify(mark)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
const fgOf = (mark: string) => channels(mark, 38);
/** The ground the glyph was cut out of — only the pop has one. */
const bgOf = (mark: string) => channels(mark, 48);
/** The glyph with every SGR stripped — one code point, always. */
const glyphOf = (mark: string) => mark.replace(SGR, "");

describe("formatAgentStatusLine", () => {
  it("renders one mark per running agent, in order, in that type’s colour", () => {
    const line = formatAgentStatusLine(
      [running("finder"), running("worker")],
      0,
      byType({ finder: amber(), worker: cyan() }),
    );
    expect(line).toBe("\u001b[38;2;255;200;0m▪\u001b[39m\u001b[38;2;0;200;255m▪\u001b[39m");
  });

  it("morphs the square through four frames in cycle order, in the agent’s literal colour", () => {
    const frames = PHASES.map((phase) => formatAgentStatusLine([running()], phase, amber));
    expect(frames).toEqual([...AMBER_CYCLE]);
    // the look itself is the exported table, on one line: grows, opens to a frame, shrinks back
    expect(RUN_PHASE_GLYPHS).toEqual(["▪", "■", "□", "■"]);
    expect(frames.map(glyphOf)).toEqual([...RUN_PHASE_GLYPHS]);
    for (const frame of frames) expect(fgOf(frame)).toEqual([255, 200, 0]);
    // every frame draws exactly one glyph — the mark's width cannot change under the animation
    for (const frame of frames) expect([...glyphOf(frame)]).toHaveLength(1);
    // three shapes across four frames: the ping-pong retraces the filled square, always one beat
    // after the frame it retraces, never beside itself
    expect(new Set(frames).size).toBe(3);
    expect(frames[1]).toBe(frames[3]);
    expect(frames[1]).not.toBe(frames[0]);
    expect(frames[2]).not.toBe(frames[1]);
    expect(frames[3]).not.toBe(frames[2]);
    // and the animation is the glyph alone: no intensity, no background, no attribute
    for (const frame of frames) {
      expect(frame).not.toContain("\u001b[48;2;");
      expect(frame).not.toContain("\u001b[2m");
    }
  });

  it("lags each running mark one frame behind the one before it, so the row travels instead of flashing", () => {
    const head = running("finder");
    const follower = running("worker");
    const lag = offsetsOf({ [head.id]: 0, [follower.id]: 1 });
    const twoUp = [head, follower];

    for (const phase of PHASES) {
      const line = formatAgentStatusLine(twoUp, phase, amber, NO_POP, lag);
      // mark 2 draws exactly the mark a single runner would have drawn one beat earlier
      expect(line).toBe(
        formatAgentStatusLine([head], phase, amber) + formatAgentStatusLine([follower], laggedPhase(phase, 1), amber),
      );
      expect(glyphOf(line)).toBe(RUN_PHASE_GLYPHS[phase] + RUN_PHASE_GLYPHS[laggedPhase(phase, 1)]);
    }
    // the whole look of the pair, written out: the cycle read one step further back each mark
    expect(PHASES.map((phase) => glyphOf(formatAgentStatusLine(twoUp, phase, amber, NO_POP, lag)))).toEqual([
      "▪■", "■▪", "□■", "■□",
    ]);
    // an uncoloured type lags too — the cascade is the glyph, not the paint
    expect(formatAgentStatusLine([running("plain")], 0, uncolored, NO_POP, offsetsOf({ "plain-running": 1 }))).toBe(
      RUN_PHASE_GLYPHS[3],
    );
  });

  it("cascades a three-mark row: every mark one frame further back than the one before", () => {
    const agents = [running("finder"), running("worker"), running("reviewer")];
    const lag = offsetsOf({ "finder-running": 0, "worker-running": 1, "reviewer-running": 2 });

    for (const phase of PHASES) {
      const line = formatAgentStatusLine(agents, phase, amber, NO_POP, lag);
      expect(glyphOf(line)).toBe(
        RUN_PHASE_GLYPHS[phase]
        + RUN_PHASE_GLYPHS[laggedPhase(phase, 1)]
        + RUN_PHASE_GLYPHS[laggedPhase(phase, 2)],
      );
    }
    expect(glyphOf(formatAgentStatusLine(agents, 0, amber, NO_POP, lag))).toBe("▪■□");
    expect(glyphOf(formatAgentStatusLine(agents, 1, amber, NO_POP, lag))).toBe("■▪■");
  });

  it("leaves the marks in unison when the caller offers no offsets at all", () => {
    const agents = [running("finder"), running("worker"), running("reviewer")];
    for (const phase of PHASES) {
      const line = formatAgentStatusLine(agents, phase, amber);
      expect(glyphOf(line)).toBe(RUN_PHASE_GLYPHS[phase].repeat(3));
      // an empty provider is the same row as no provider: the cascade is opt-in
      expect(formatAgentStatusLine(agents, phase, amber, NO_POP, offsetsOf({}))).toBe(line);
    }
  });

  it("ignores the offset entirely for a queued or a finished mark — only a run travels", () => {
    const waiting = agent("finder", "queued");
    const done = agent("finder", "completed");
    const lag = offsetsOf({ [waiting.id]: 3, [done.id]: 2 });

    for (const phase of PHASES) {
      expect(formatAgentStatusLine([waiting], phase, amber, NO_POP, lag)).toBe(AMBER_QUEUED);
      expect(formatAgentStatusLine([done], phase, amber, NO_POP, lag)).toBe(AMBER_STEADY);
      // byte-identical to the same row rendered with no offsets at all
      expect(formatAgentStatusLine([waiting], phase, amber, NO_POP, lag)).toBe(
        formatAgentStatusLine([waiting], phase, amber),
      );
      expect(formatAgentStatusLine([done], phase, amber, NO_POP, lag)).toBe(formatAgentStatusLine([done], phase, amber));
    }
    // neither a pop nor a queued mark is re-phased by the cascade either
    expect(formatAgentStatusLine([done], 1, amber, new Map([[done.id, POP_OPEN]]), lag)).toBe(AMBER_POP);
  });

  it("renders a queued agent as the small hollow square, SGR 2, in its colour, at every phase", () => {
    const queued = agent("finder", "queued");
    const frames = PHASES.map((phase) => formatAgentStatusLine([queued], phase, amber));
    expect(frames).toEqual([AMBER_QUEUED, AMBER_QUEUED, AMBER_QUEUED, AMBER_QUEUED]);
    // the grey-out is the SGR 2 attribute (ansi_up renders it as opacity), not a different glyph
    expect(frames[0]).toContain("\u001b[2m");
    expect(glyphOf(frames[0])).toBe("▫");
    expect(fgOf(frames[0])).toEqual([255, 200, 0]);
    // a queued mark has no finish to celebrate: a pop entry must not touch it
    expect(PHASES.map((phase) => formatAgentStatusLine([queued], phase, amber, new Map([[queued.id, POP_OPEN]])))).toEqual(
      frames,
    );
  });

  it("renders a finished agent as the steady dense square — the pop’s glyph, not a luminance flash", () => {
    const done = agent("finder", "completed");
    const steady = formatAgentStatusLine([done], 0, amber);
    expect(steady).toBe(AMBER_STEADY);
    expect(glyphOf(steady)).toBe("▓");
    // never a glyph the run itself draws, so a settled mark is never a still running one
    expect(RUN_PHASE_GLYPHS).not.toContain(glyphOf(steady));
    for (const phase of PHASES) expect(formatAgentStatusLine([done], phase, amber)).toBe(steady);
  });

  it("pops a finished id: black square on the agent’s own colour, then on a lighter ground", () => {
    const done = agent("finder", "completed");
    const open = formatAgentStatusLine([done], 0, amber, new Map([[done.id, POP_OPEN]]));
    const light = formatAgentStatusLine([done], 0, amber, new Map([[done.id, POP_SECOND]]));

    expect(open).toBe(AMBER_POP);
    expect(light).toBe(AMBER_POP_LIGHT);
    // two frames, and they are two: the second is the first's ground lightened toward white
    expect(open).not.toBe(light);
    expect(bgOf(open)).toEqual([255, 200, 0]);
    expect(bgOf(light)).toEqual([255, 228, 128]);
    expect(bgOf(open).map((channel) => Math.round(channel + (255 - channel) * 0.5))).toEqual(bgOf(light));
    // it is an invert, not a brightness: the glyph is black and its ground is the agent's colour
    expect(fgOf(open)).toEqual([0, 0, 0]);
    expect(fgOf(light)).toEqual([0, 0, 0]);
    // the pop is constant while it burns — it does not morph with the phase
    expect(PHASES.map((phase) => formatAgentStatusLine([done], phase, amber, new Map([[done.id, POP_OPEN]])))).toEqual(
      [open, open, open, open],
    );
    expect(glyphOf(open)).toBe(steady(done).replace(SGR, ""));
  });

  it("leaves a finished mark alone unless its own id is popping", () => {
    const done = agent("finder", "completed");
    const steady = formatAgentStatusLine([done], 0, amber);
    expect(formatAgentStatusLine([done], 0, amber, NO_POP)).toBe(steady);
    expect(formatAgentStatusLine([done], 0, amber, new Map([["someone-else", POP_OPEN]]))).toBe(steady);
    for (const phase of PHASES) {
      expect(formatAgentStatusLine([done], phase, amber, NO_POP)).toBe(steady);
    }
  });

  it("falls back to a bare glyph with no SGR at all when the type has no colour", () => {
    for (const phase of PHASES) {
      expect(formatAgentStatusLine([running("plain")], phase, uncolored)).toBe(RUN_PHASE_GLYPHS[phase]);
    }
    expect(formatAgentStatusLine([agent("plain", "queued")], 2, uncolored)).toBe("▫");
    expect(formatAgentStatusLine([agent("plain", "completed")], 0, uncolored)).toBe("▓");
    // nothing to paint, so nothing to invert either
    expect(
      formatAgentStatusLine([agent("plain", "completed")], 0, uncolored, new Map([["plain-completed", POP_OPEN]])),
    ).toBe("▓");
  });

  it("is empty when there is nothing to show", () => {
    expect(formatAgentStatusLine([], 3, amber)).toBe("");
  });
});

/** The settled frame for `done`, reused by the pop test to prove the pop keeps the steady glyph. */
function steady(done: StatusAgent): string {
  return formatAgentStatusLine([done], 0, amber);
}
