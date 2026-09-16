/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { type AgentSession, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../lib/types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../lib/usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, fgPreservingNestedStyles, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { blockTint, indexToolResults, renderResultBlock, renderToolBlock, resultText, type ViewerToolResult } from "./viewer-blocks.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/**
 * The overlay options **every** entry point must open this viewer with.
 *
 * Shared rather than written out twice: the two entry points (`/agents`, and a row in the FleetView)
 * had drifted, and the FleetView's copy still asked for a centered, 90%-wide, **70%-tall** frame.
 * pi sizes an overlay from `maxHeight` and slices anything past it from the bottom, so on a
 * `terminal.rows`-tall component that 70% cut this viewer's own footer row and bottom border off the
 * screen — a frame with no bottom, opened by exactly the route the user takes.
 */
export const VIEWER_OVERLAY = {
  overlay: true,
  overlayOptions: {
    anchor: "top-center",
    width: "100%",
    // A ceiling, not the size: the component reserves pi's chrome itself (see
    // VIEWER_BOTTOM_RESERVED_ROWS) and must stay strictly under it.
    maxHeight: "100%",
  },
} as const;

/** Base lines consumed by chrome: top border + header + header rule + footer + bottom border. */
const CHROME_LINES_BASE = 5;
const MIN_VIEWPORT = 3;
/**
 * Rows at the bottom of the screen the viewer leaves uncovered.
 *
 * Zero: the viewer takes the whole screen, because it is opened to read one transcript and the
 * reader asked for height twice. Raising it is a one-number change and the reason to: pi's own
 * input editor, the fleet list below it and the status bar are drawn *after* the transcript rather
 * than pinned to the screen bottom, so where they land depends on how long the transcript is —
 * reserving rows at the bottom only finds them when the transcript has pushed them there, and on a
 * fresh session the reserve is simply blank space. Nothing measurable from inside an extension can
 * place that split, so this is a preference, not a calculation: 0 for the tallest viewer, ~10 to
 * keep the editor and status rows in view for the common long-transcript case.
 *
 * The other half of the arithmetic is not a preference. An overlay is composited over the whole
 * screen and its height is `min(component, maxHeight)`, with an over-tall component cropped **from
 * the top** — which is what used to eat this viewer's own footer and bottom border. The component
 * therefore renders exactly `terminal.rows` rows, matching the cap rather than exceeding it, so
 * every row it draws is shown. `Esc` still closes it.
 */
export const VIEWER_BOTTOM_RESERVED_ROWS = 3;

/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * The cap is not cosmetic — it bounds render cost. `buildContentLines()` runs on
 * every render *and* on every scroll key (`handleInput` calls it to compute
 * `maxScroll`), so an uncapped 200 KB result costs ~6 ms per keystroke to parse
 * as Markdown, against ~0.5 ms once capped and effectively nothing on a cache
 * hit (best of 5, width 76). 16 KB is roughly a screenful at every terminal size
 * and still ~30x the 500 characters this replaces, which was small enough to cut
 * most real results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;

/** The one mode there is: everything the viewer can render as Markdown, does. */
const MARKDOWN_MODE: ViewerMarkdownMode = "all";

/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  /**
   * The `e` toggle: compact blocks by default, every body and parameter set once expanded.
   * Viewer-local on purpose — it answers "show me more of *this* transcript", which is a
   * per-inspection question, not a setting.
   */
  private expanded = false;
  /**
   * Live output of tools still running, keyed by tool call.
   *
   * Fed by `tool_execution_update` off the session stream. `write` never emits one (it
   * ignores its update callback), which is why its "line being written" is read from the
   * call's arguments instead — see `viewer-blocks.ts`.
   */
  private readonly partials = new Map<string, string>();
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /**
   * One `Markdown` per message, so its own text/width cache does the work. A
   * fresh instance per render would re-parse the whole transcript on every
   * keystroke — the component caches, but only across calls to the same object.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();

  /**
   * The terminal's row count when this overlay was created.
   *
   * pi resolves `overlayOptions` **once**, at show time, and stores the resulting `maxHeight`; then,
   * on every frame, it drops any overlay line beyond it (`overlayLines.slice(0, maxHeight)`). A
   * terminal that grows while the viewer is open therefore leaves this component rendering more
   * rows than the cap still allows, and the lines thrown away are the **last** ones — the footer
   * and the bottom border. That is a frame with no bottom, not a clipped one. Capping the render at
   * the height captured here keeps the component inside the cap the overlay is actually using;
   * reopening the viewer picks up a new size.
   */
  private readonly rowsAtOpen: number;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * The user's `viewerMarkdown` setting, read live so a change made in
     * `/agents → Settings` lands on the next frame. Omitted → Markdown.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
  ) {
    this.rowsAtOpen = tui.terminal.rows;
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe((event) => {
      if (this.closed) return;
      if (event.type === "tool_execution_update") {
        const text = (event as any).partialResult?.content?.[0]?.text;
        if (typeof text === "string") this.partials.set(event.toolCallId, text);
      } else if (event.type === "tool_execution_end") {
        // The result now carries the whole output; a stale partial would only shadow it.
        this.partials.delete(event.toolCallId);
      }
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    // No raw/Markdown key any more: the viewer renders Markdown, and the only switch left is
    // the `viewerMarkdown` setting under `/agents → Settings`.

    // Compact ↔ full for the whole view. One key, no per-block state: the question this
    // answers is "give me the detail", not "expand that one block over there".
    if (matchesKey(data, "e")) {
      this.expanded = !this.expanded;
      this.stopArmed = false;
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    // The bottom edge is drawn in the accent colour, not the border colour: it lands on the row
    // where the input box's own rule would be, and a line that looks like pi's chrome would read
    // as the editor rather than as the viewer's edge over it.
    const hrBot = th.fg("accent", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    // Context from the live session, spend from the record: the record is the only total that
    // survives the agent finishing. Cost and the tool-use count are deliberately absent — the
    // header carries identity and context pressure, not a running invoice.
    const headerStats: Array<{ key: string; text: string }> = [];
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerStats.push({ key: "ctx", text: formatSessionTokens(tokens, percent, th, this.record.compactionCount) });
    }
    const invocation = this.headerInvocation();
    if (invocation) headerStats.push({ key: "model", text: invocation });
    headerStats.push({ key: "duration", text: duration });

    // The description is not a fixed cost: the reader gets every column the stats do not need,
    // and the stats themselves are kept by priority. Measuring the *untruncated* description
    // instead would let a long one push every stat off the line, which is the behavior this
    // header exists to replace.
    const headerPrefix = `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}`;
    const prefixWidth = visibleWidth(headerPrefix);
    /**
     * Least description worth showing, so the stats can never squeeze it out entirely.
     *
     * 12 columns reads as "Fix the u…", which identifies nothing; at 20 a narrow terminal
     * still says what the agent is for, and the stats yield the columns instead.
     */
    const MIN_DESCRIPTION = 20;

    // Priority order — the reverse of the drop order in the spec: context pressure, then
    // elapsed time, then which model produced this at all.
    const byKey = new Map(headerStats.map(s => [s.key, s.text]));
    // Chosen by priority — context pressure, then elapsed time, then the model and its level —
    // but rendered in reading order, so the line does not reshuffle itself as width changes.
    const displayOrder = ["ctx", "model", "duration"];
    const kept = new Set<string>();
    for (const key of ["ctx", "duration", "model"]) {
      if (!byKey.has(key)) continue;
      const candidate = displayOrder.filter(k => kept.has(k) || k === key).map(k => byKey.get(k) as string);
      // +3 for the separator between the description and the stats group.
      if (prefixWidth + 1 + MIN_DESCRIPTION + 3 + visibleWidth(candidate.join(" · ")) <= innerW) {
        kept.add(key);
      }
    }
    const headerStatsShown = displayOrder.filter(k => kept.has(k)).map(k => byKey.get(k) as string);

    const statsWidth = headerStatsShown.length > 0 ? 3 + visibleWidth(headerStatsShown.join(" · ")) : 0;
    const descriptionBudget = Math.max(1, Math.min(visibleWidth(this.record.description), innerW - prefixWidth - 1 - statsWidth));
    const statsText = headerStatsShown.length > 0
      ? ` ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerStatsShown.join(" · "))}`
      : "";

    lines.push(row(`${headerPrefix} ${th.fg("muted", truncateToWidth(this.record.description, descriptionBudget))}${statsText}`));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer. The rule above it is gone: the bottom border already closes the frame, and
    // that row is worth more as a line of transcript.
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Operations on the left, navigation on the right, fitted by priority rather than by
      // truncation: an overflowing row loses its tail, and the tail is where `Esc` lives —
      // the one key a reader needs to get out of here on a narrow pane. So the navigation
      // group has shorter forms to fall back to, and the line-count readout yields first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      actions.push(th.fg("dim", this.expanded ? "e collapse" : "e expand"));

      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      // Widest first on both sides. The left group loses its readout before any key, then its
      // keys from the right — `e` before `m`, `m` before `x stop`, `x stop` before the steer
      // prompt; the navigation group shortens to a bare `Esc`. Nothing here is dropped while a
      // shorter form still fits, which is what a terminal-narrow row used to do silently.
      const leftVariants = [[count, ...actions].join(sep)];
      for (let dropped = 0; dropped <= actions.length; dropped++) {
        leftVariants.push(actions.slice(0, actions.length - dropped).join(sep));
      }
      const rightVariants = ["↑↓ · PgUp/PgDn · Esc", "↑↓ · Esc", "Esc"].map(v => th.fg("dim", v));

      let footerLeft = leftVariants[leftVariants.length - 1];
      let footerRight = rightVariants[rightVariants.length - 1];
      let fitted = false;
      for (const left of leftVariants) {
        for (const right of rightVariants) {
          if (visibleWidth(left) + visibleWidth(right) + 1 <= innerW) {
            footerLeft = left;
            footerRight = right;
            fitted = true;
            break;
          }
        }
        if (fitted) break;
      }

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** The mode in force: the setting, else Markdown. */
  private markdownMode(): ViewerMarkdownMode {
    return this.viewerMarkdown?.() ?? MARKDOWN_MODE;
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /** Render `text` as Markdown, reusing this message's component instance. */
  private markdownLines(msg: object, text: string, width: number, dim: boolean): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          // Keeps result prose visually receded, the way the raw path's
          // per-line `fg("dim", …)` did. Fenced code is the exception and is
          // left alone deliberately: pi's theme highlights it with its own
          // colors, which this would otherwise flatten.
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      // Streaming: the message object is stable, its text grows. A failed
      // prefix remains unsafe after append-only deltas, so retry only when the
      // content was replaced or truncated.
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, dim);

    try {
      return entry.md.render(width);
    } catch {
      // The parser is recursive and this is arbitrary tool output: ~54 nested
      // blockquotes overflow the stack, and no amount of fuzzing proves that is
      // the only such input. `render()` is on the TUI's critical path, so a
      // throw here takes the overlay down for content the literal path shows
      // fine — degrade to that instead, and remember, since the throw would
      // otherwise repeat on every render and every scroll key.
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    // The open-time height is an upper bound, never the current one — see `rowsAtOpen`.
    const rows = Math.min(this.tui.terminal.rows, this.rowsAtOpen);
    const maxRows = rows - VIEWER_BOTTOM_RESERVED_ROWS;
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.composer ? 1 : 0);
  }

  /**
   * The model and thinking level this run used, for the header's stats.
   *
   * Canonical id here, short label everywhere else: this overlay is opened to inspect one
   * agent and has the width for it, and two providers can serve models whose short names
   * read alike. Returns undefined when nothing was captured.
   */
  private headerInvocation(): string | undefined {
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", parts.join(" · "));
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    const mode = this.markdownMode();
    const results = indexToolResults(messages);
    // Which results a tool call will draw. Anything else is standing alone (its call was
    // compacted away or predates this session) and still gets a block of its own.
    const carried = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.content) if (part.type === "toolCall") carried.add(part.id);
    }

    // Blocks are separated by a blank line, not a rule: every block already opens with a
    // mark, and the rules were half the vertical budget this view is trying to win back.
    let needsGap = false;
    const push = (block: string[]) => {
      if (block.length === 0) return;
      if (needsGap) lines.push("");
      lines.push(...block);
      needsGap = true;
    };

    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text.trim()) continue;
        const wrapped = wrapTextWithAnsi(text.trim(), Math.max(1, width - 2));
        push(wrapped.map((line, i) => (i === 0 ? `${th.fg("accent", "▌")} ${line}` : `  ${line}`)));
        continue;
      }

      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text" && part.text?.trim()) {
            const text = part.text.trim();
            push(mode === "off" ? this.rawLines(text, width, false) : this.markdownLines(msg, text, width, false));
          } else if (part.type === "toolCall") {
            const result = results.get(part.id);
            const capped = result ? this.capForView(result) : undefined;
            let block = renderToolBlock(
              { id: part.id, name: (part as any).name ?? "tool", arguments: (part as any).arguments },
              capped?.result,
              { width, expanded: this.expanded, partial: this.partials.get(part.id) },
            );
            // `md+` renders an expanded result as Markdown — the one thing that setting still
            // buys now that bodies come from the block model rather than a raw dump.
            if (mode === "all" && this.expanded && capped?.result && !capped.result.isError) {
              const text = resultText(capped.result);
              if (text) block = [block[0], ...this.markdownLines(capped.result, text, width, true).map(l => `  ${l}`)];
            }
            block = [this.tintedHead(block[0], width), ...block.slice(1)];
            if (capped?.elided) block.push(truncateToWidth(th.fg("dim", truncationNote(capped.elided)), width));
            push(block);
          }
        }
        continue;
      }

      if (msg.role === "toolResult") {
        if (carried.has(msg.toolCallId)) continue;
        const capped = this.capForView(msg as ViewerToolResult);
        let block = renderResultBlock(
          (msg as ViewerToolResult).toolName ?? "tool",
          capped.result,
          { width, expanded: this.expanded },
        );
        if (mode === "all" && this.expanded && capped.result && !capped.result.isError) {
          const text = resultText(capped.result);
          if (text) block = [block[0], ...this.markdownLines(capped.result, text, width, true).map(l => `  ${l}`)];
        }
        block = [this.tintedHead(block[0], width), ...block.slice(1)];
        if (capped.elided) block.push(truncateToWidth(th.fg("dim", truncationNote(capped.elided)), width));
        push(block);
        continue;
      }

      if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        const block = [truncateToWidth(th.fg("muted", `$ ${bash.command}`), width)];
        if (bash.output?.trim()) {
          // Same cap as a tool result, never Markdown: command output is the one
          // thing here that is definitionally not authored as Markdown.
          const { text, elided } = capResult(bash.output.trim());
          block.push(...this.rawLines(text, width, true));
          if (elided) block.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        }
        push(block);
      }
    }

    // No trailing activity line. It echoed the run's own prose back ("▍ I'll start with batched
    // discovery…") directly under the message it came from, and what it added — which tool is
    // running — is already the last block's own `⟳` head.

    return lines.map(l => truncateToWidth(l, width));
  }

  /**
   * A block's head, painted with pi's own tool-block background and padded to the full row.
   *
   * The padding is the point: a background that stops at the last character outlines the text
   * instead of marking the row. The tint is what makes a tool call read as one unit at a
   * glance without dimming the body underneath it, which is the part worth reading.
   */
  private tintedHead(head: string, width: number): string {
    const theme = this.theme;
    // Called on the theme, never destructured: pi's `bg` is a class method that reads its own
    // color table off `this`, so an unbound call throws on the first render of a tool call.
    if (typeof theme.bg !== "function") return head;
    const padded = head + " ".repeat(Math.max(0, width - visibleWidth(head)));
    return theme.bg(blockTint(head), padded);
  }

  /**
   * Bound a result's text before the block model sees it, keeping the elided count separate.
   *
   * The cap is not cosmetic — it is what bounds the per-keystroke cost of rebuilding the
   * content — and the count has to survive as chrome, because the block model's own `⋯`
   * markers only report the lines *it* dropped.
   */
  private capForView(result: ViewerToolResult): { result: ViewerToolResult; elided: number } {
    const raw = resultText(result);
    const { text, elided } = capResult(raw);
    if (!elided) return { result, elided: 0 };
    return { result: { ...result, content: [{ type: "text", text }] }, elided };
  }
}
