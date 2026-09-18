/**
 * agent-status-line.ts — the extension status row: one coloured mark per agent.
 *
 * Replaces the old `"3 running, 1 queued agents"` text. Four states, and the glyph set is the whole
 * vocabulary:
 *
 *   running  → the square morph, one glyph per phase, in the agent type's literal truecolor (and,
 *              given a `PhaseOffsets`, each mark a frame behind the one before it — the wave)
 *   popping  → a finishing mark: two frames of an invert pop, then settled
 *   queued   → the small hollow square, greyed out with SGR 2
 *   finished → the dense square, solid until the caller ages it out at the next turn
 *
 * Pure and timer-free: the caller owns the clock, the phase, how far each mark lags, the pop window
 * and the turn-age window, so this stays provable with a unit test instead of a live terminal.
 */
import { getConfig } from "../config/registry/agent-types.js";
import type { AgentRecord } from "../lib/types.js";
import { renderAgentMark } from "./agent-color.js";

/** Cycle phase. Four frames, one glyph each: see `RUN_PHASE_GLYPHS`. */
export type StatusPhase = 0 | 1 | 2 | 3;

/** One glyph per phase, in cycle order. See `RUN_PHASE_GLYPHS`. */
export type PhaseGlyphs = readonly [string, string, string, string];

/**
 * THE ANIMATION — one glyph per phase, in cycle order. This array is the row's whole look, and the
 * single place to change it.
 *
 * Everything else is plumbing with no opinion about these characters: `agent-status-bar.ts` owns
 * only *when* the phase advances (when the clock runs at all, and how far each mark lags the one
 * before it), `formatAgentStatusLine` owns only the lookup, and the bar's suite derives every frame
 * it expects from this array. Swap these four
 * characters (or the whole table) and the row animates differently — with no edit to the bar, the
 * clock rule, the pop, or the bar's tests. The one test file a new look has to be recorded in is the
 * line suite's literal frame table, which is where the look is pinned on purpose.
 *
 * The morph is a square: it grows (`▪`→`■`), opens into a frame at full size (`■`→`□`), then shrinks
 * back along the same table. The shape itself is what moves — a glyph that never changes shape reads
 * as flicker rather than activity — and because the table ping-pongs, the return trip needs no extra
 * frames: the fourth beat retraces the second, so one cycle draws three shapes and no two
 * consecutive beats repeat.
 *
 * Coverage and width, measured here with fontTools against JetBrains Mono Regular's cmap (the
 * terminal's mono font): `▪` (U+25AA), `■` (U+25A0), `□` (U+25A1), `▫` (U+25AB) and `▓` (U+2593)
 * are all present and all draw at exactly 0.6000 em — one cell — so neither the morph nor the
 * settle can drift the row. `◻ ◼ ◾ ◽ ▢ ⬛ ▣` are *missing* from that font, so none of them can be
 * used.
 *
 * Width class is the one caveat, and it is inherited rather than introduced: `■`/`□` are East-Asian
 * *Ambiguous* (U+25A0 and U+25A1), the same class as the `●`/`○` this row shipped before, so a CJK
 * terminal configured "ambiguous = wide" could render those two frames two cells wide. `▪`/`▫` are
 * *Neutral*, so half the cycle is safe. If width drift is ever observed, the fully-Neutral options
 * are the quadrant corners `▖▘▝▗` (also present, also 0.6000 em) — quoted here so the fallback does
 * not have to be re-measured.
 */
export const RUN_PHASE_GLYPHS: PhaseGlyphs = ["▪", "■", "□", "■"];

/**
 * Waiting: the small hollow square — the cycle's geometry, one size down, greyed out rather than
 * replaced. SGR 2 is the one axis that says "not yet" without spending a new shape on it.
 */
const QUEUED_GLYPH = "▫";

/**
 * Settled — and the glyph the pop cuts out of the agent's own colour.
 *
 * Deliberately *not* `■`: that square is two of the run's four frames, so a lone settled mark would
 * be byte-identical to a running one and only motion — which stops — would say which it is. `▓`
 * (U+2593) is the same geometry one step denser, measured present in JetBrains Mono at the same
 * 0.6000 em, and it keeps the margin `■` has, so a run of settled marks stays a row of marks rather
 * than merging into one bar the way `█` (U+2588, also present) would. The shades `░`/`▒` recede
 * instead of settling — they read as the queued mark's "not yet".
 */
const FINISHED_GLYPH = "▓";

/** How far the pop's second frame mixes its ground toward white. */
const POP_LIGHTEN = 0.5;

/** The slice of an agent the status row needs — nothing else is read. */
export interface StatusAgent {
  /** The caller's aging key — the formatter never reads it, but a pop is keyed on it. */
  id: string;
  type: string | undefined;
  status: AgentRecord["status"];
}

/** How a type turns into a colour. Injectable so tests never touch the agent registry. */
export type ColorResolver = (type: string | undefined) => string | undefined;

const configuredColor: ColorResolver = (type) => (type ? getConfig(type).color : undefined);

/**
 * Which ids a finish pop is burning for, and how many beats of it are still owed.
 *
 * Structural on purpose: the caller's own countdown `Map` answers this as-is — `2` on the beat the
 * agent finishes, `1` on the tick after, absent once the mark has settled — so how *long* a pop
 * lasts stays the caller's business, and all this module decides is what its beats look like.
 */
export interface PopWindow {
  /** Beats still owed for this id, or `undefined` when it is not popping. */
  get(id: string): number | undefined;
}

/** No agent is popping. */
const NOT_POPPING: PopWindow = { get: () => undefined };

/**
 * How many frames of the cycle each id's mark lags the head of the cascade by, keyed by agent id.
 *
 * The lag is what turns a row of running marks into a travelling wave: the head draws the current
 * frame and every mark behind it draws a frame it has already played, so the row reads left to
 * right instead of flashing in unison. An id with no entry is the head (offset 0).
 *
 * Structural on purpose, exactly like `PopWindow`: the bar's own `Map` answers this as-is, and a
 * caller that never builds one gets the synchronised row this module rendered before the cascade
 * existed — the cascade is opt-in, and no caller that ignores it changes behaviour.
 */
export interface PhaseOffsets {
  /** Frames of lag for this id, or `undefined` when it leads the cascade. */
  get(id: string): number | undefined;
}

/** Nobody lags: every running mark draws the current frame. */
const NO_OFFSETS: PhaseOffsets = { get: () => undefined };

/**
 * The frame a run at `offset` frames of lag is drawing while the head is at `phase` — the lookup
 * the whole cascade is.
 *
 * The subtraction is done in the cycle's own arithmetic rather than pre-wrapped by the caller, so
 * an offset that runs past the table wraps to a mark already in the wave instead of off the front
 * of it (which would render `undefined`).
 */
function laggedPhase(phase: StatusPhase, offset: number): StatusPhase {
  const frames = RUN_PHASE_GLYPHS.length;
  return ((((phase - offset) % frames) + frames) % frames) as StatusPhase;
}

/**
 * One mark per agent, in the order given, or `""` when there is nothing to show.
 *
 * The caller decides which agents are still worth a mark (finished ones age out by turn), so an
 * empty list is the only way this returns nothing. `popping` is the caller's finish-pop window:
 * those ids render the pop's frames whatever the phase. A queued mark is checked first, so neither
 * the cycle nor a pop can ever touch one.
 *
 * `offsets` is the cascade, and it applies to a running mark alone: a queued or finished mark is
 * still, and an offset must not make it twitch. With no provider every running mark draws `phase`
 * and the row is the synchronised one this function drew before the cascade existed.
 */
export function formatAgentStatusLine(
  agents: readonly StatusAgent[],
  phase: StatusPhase,
  resolveColor: ColorResolver = configuredColor,
  popping: PopWindow = NOT_POPPING,
  offsets: PhaseOffsets = NO_OFFSETS,
): string {
  return agents
    .map((agent) => {
      const color = resolveColor(agent.type);
      if (agent.status === "queued") return renderAgentMark(color, QUEUED_GLYPH, { faint: true });
      const beats = popping.get(agent.id);
      if (beats !== undefined) {
        // The pop's opening beat inverts the mark on the agent's own colour; the beat after it keeps
        // the dark glyph on a lighter ground, so the settle reads as one gesture rather than a fade.
        return renderAgentMark(color, FINISHED_GLYPH, { invert: beats > 1 ? 0 : POP_LIGHTEN });
      }
      if (agent.status === "running") {
        return renderAgentMark(color, RUN_PHASE_GLYPHS[laggedPhase(phase, offsets.get(agent.id) ?? 0)]);
      }
      return renderAgentMark(color, FINISHED_GLYPH);
    })
    .join("");
}
