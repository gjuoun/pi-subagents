import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot, AgentStatus } from "../domain/agent.js";
import { formatModel, formatTokens } from "./agent-row.js";

/**
 * fleet-view.ts — the Claude Code-style FleetView list below the editor (JW-166 port of the v1
 * core's ui/fleet-list.ts, PR #24 row layout).
 *
 * One row per live agent (plus the one being viewed, plus agents finished in the last few
 * seconds), earliest-launched first. `↓`/`←` at an empty prompt focuses the list; `↑`/`↓`
 * move the ● marker; Enter opens the agent (the conversation viewer); Esc — or `↑` above the
 * first row — returns to the prompt. Row: marker, status emoji, clock, name, description;
 * flush right `<model - thinking>  <tokens ctx%>`, ctx amber from 60% and red from 85%.
 *
 * Mechanics: a `belowEditor` widget (render only); keys arrive through `onTerminalInput`,
 * which fires before the editor and can consume them, gated on an empty prompt so typing is
 * untouched. The ui is a structural port — nothing here value-imports pi-coding-agent.
 */

export const FLEET_KEY = "pi-subagents-fleet";
const MAX_ROWS = 5;
const TICK_MS = 200;
export const FINISHED_LINGER_MS = 4000;
const CONTEXT_WARN = 60;
const CONTEXT_CRITICAL = 85;

/** The colour slice of pi's Theme the list uses. */
export interface FleetTheme {
  fg(color: string, text: string): string;
}

/** The slice of `ctx.ui` the list drives. */
export interface FleetUi {
  setWidget(
    key: string,
    content: undefined | ((tui: unknown, theme: FleetTheme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
}

/** Badge-aware name renderer, supplied by the caller (agent colour, Step 16). */
export type NameRenderer = (snapshot: AgentSnapshot, theme: FleetTheme, selected: boolean) => string;

const STATUS: Record<AgentStatus, { readonly icon: string; readonly color: string }> = {
  queued: { icon: "🕒", color: "dim" },
  running: { icon: "⏳", color: "warning" },
  done: { icon: "✅", color: "success" },
  error: { icon: "❌", color: "error" },
  aborted: { icon: "🛑", color: "error" },
};

/** `11s` — integer seconds, padded so the name column does not shift as the clock grows. */
export function elapsedCell(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`.padStart(4);
}

/** Place `right` flush to `width`, truncating `left` first; never exceeds `width`. */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const leftClamped = truncateToWidth(left, Math.max(0, width - rightW - 1));
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

/** The bits of pi's TUI the list peeks at. */
interface TuiLike {
  requestRender?(): void;
  focusedComponent?: unknown;
}

const plainName: NameRenderer = (s, theme, selected) => theme.fg(selected ? "text" : "muted", s.name);

export class FleetView {
  readonly #source: () => ReadonlyArray<AgentSnapshot>;
  readonly #open: (id: string) => Promise<void> | void;
  readonly #now: () => number;
  readonly #renderName: NameRenderer;
  #ui: FleetUi | undefined;
  #tui: TuiLike | undefined;
  #unsubscribe: (() => void) | undefined;
  #registered = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Whether arrow keys navigate the list (vs. flow to the editor). */
  #active = false;
  /** 0 = back at the prompt, 1..N = rows. */
  #selected = 0;
  /** Set while an agent is open; that agent stays listed. */
  #viewing: string | undefined;

  constructor(
    source: () => ReadonlyArray<AgentSnapshot>,
    open: (id: string) => Promise<void> | void,
    options: { readonly now?: () => number; readonly renderName?: NameRenderer } = {},
  ) {
    this.#source = source;
    this.#open = open;
    this.#now = options.now ?? Date.now;
    this.#renderName = options.renderName ?? plainName;
  }

  /** Bind to a session's UI: take terminal input and start ticking. */
  attach(ui: FleetUi): void {
    this.#unsubscribe?.();
    this.#ui = ui;
    this.#registered = false;
    this.#tui = undefined;
    this.#unsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
    this.#timer ??= setInterval(() => this.refresh(), TICK_MS);
    this.refresh();
  }

  dispose(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#ui && this.#registered) this.#ui.setWidget(FLEET_KEY, undefined);
    this.#registered = false;
    this.#ui = undefined;
    this.#active = false;
  }

  /** The rows shown, earliest-launched first. */
  rows(): AgentSnapshot[] {
    const now = this.#now();
    return this.#source()
      .filter(
        (s) =>
          s.status === "running" ||
          s.status === "queued" ||
          s.id === this.#viewing ||
          (s.finishedAt !== undefined && now - s.finishedAt < FINISHED_LINGER_MS),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get active(): boolean {
    return this.#active;
  }

  get selected(): number {
    return this.#selected;
  }

  /** Register, repaint or clear the widget. */
  refresh(): void {
    const ui = this.#ui;
    if (!ui) return;
    const count = this.rows().length;
    if (count === 0) {
      if (this.#registered) ui.setWidget(FLEET_KEY, undefined);
      this.#registered = false;
      this.#tui = undefined;
      this.#active = false;
      this.#selected = 0;
      return;
    }
    if (this.#selected > count) this.#selected = count;
    if (!this.#registered) {
      ui.setWidget(
        FLEET_KEY,
        (tui, theme) => {
          this.#tui = tui as TuiLike;
          return {
            render: (width: number) => this.render(width, theme),
            invalidate: () => {
              this.#registered = false;
              this.#tui = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
      this.#registered = true;
    } else {
      this.#tui?.requestRender?.();
    }
  }

  /** `{consume:true}` swallows a key; undefined lets it through. */
  handleKey(data: string): { consume?: boolean } | undefined {
    const ui = this.#ui;
    if (!ui || isKeyRelease(data)) return undefined;
    if (this.#viewing !== undefined) return undefined; // the viewer owns the keyboard
    if (!this.#editorHasFocus()) {
      if (this.#active) this.#deactivate();
      return undefined;
    }
    const count = this.rows().length;
    if (!this.#active) {
      const activator = matchesKey(data, "down") || matchesKey(data, "left");
      if (activator && count > 0 && ui.getEditorText() === "") {
        this.#active = true;
        this.#selected = 1;
        this.refresh();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, "down")) {
      this.#selected = Math.min(count, this.#selected + 1);
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.#selected <= 1) this.#deactivate();
      else {
        this.#selected -= 1;
        this.refresh();
      }
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.#deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.#openSelected();
      return { consume: true };
    }
    this.#deactivate();
    return undefined;
  }

  /** The list's lines for `width`. */
  render(width: number, theme: FleetTheme): string[] {
    const rows = this.rows();
    if (rows.length === 0) return [];
    const sel = Math.min(this.#selected, rows.length);
    const visible = Math.min(MAX_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);
    const lines: string[] = [];
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let i = start; i < start + visible; i++) lines.push(this.#row(rows[i], i + 1 === sel, width, theme));
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    return lines;
  }

  #row(s: AgentSnapshot, selected: boolean, width: number, theme: FleetTheme): string {
    const base = selected ? "text" : "dim";
    const look = STATUS[s.status];
    const marker = selected ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const clock = theme.fg(look.color, elapsedCell((s.finishedAt ?? this.#now()) - s.startedAt));
    const lead = `  ${marker} ${look.icon} ${clock}  ${this.#renderName(s, theme, selected)}`;
    const description = selected ? theme.fg("text", s.description) : s.description;
    const parts: string[] = [];
    const model = formatModel(s.model, s.thinking);
    if (model) parts.push(theme.fg(base, model));
    const usage: string[] = [];
    if (s.tokens > 0) usage.push(theme.fg(base, formatTokens(s.tokens)));
    if (s.contextPercent !== undefined) {
      const color = s.contextPercent >= CONTEXT_CRITICAL ? "error" : s.contextPercent >= CONTEXT_WARN ? "warning" : base;
      usage.push(theme.fg(color, `${Math.round(s.contextPercent)}%`));
    }
    if (usage.length > 0) parts.push(usage.join(" "));
    // Narrow terminal: the description goes first, then usage, then the model.
    while (parts.length > 0 && width - visibleWidth(parts.join("  ")) - 1 < visibleWidth(lead)) parts.pop();
    const right = parts.join("  ");
    const room = width - visibleWidth(right) - 1 - visibleWidth(lead) - 2;
    return rightAlign(room >= 2 ? `${lead}  ${description}` : lead, right, width);
  }

  #editorHasFocus(): boolean {
    const focused = this.#tui?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  #deactivate(): void {
    this.#active = false;
    this.#selected = 0;
    this.refresh();
  }

  #openSelected(): void {
    const row = this.rows()[this.#selected - 1];
    if (row === undefined) {
      this.#deactivate();
      return;
    }
    this.#viewing = row.id;
    const done = () => {
      // Keep the cursor on the agent just viewed, wherever it now sits.
      const index = this.rows().findIndex((s) => s.id === row.id);
      this.#viewing = undefined;
      if (index >= 0) this.#selected = index + 1;
      this.refresh();
    };
    void Promise.resolve(this.#open(row.id)).then(done, done);
  }
}
