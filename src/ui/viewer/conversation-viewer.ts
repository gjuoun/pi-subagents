import { Input, Markdown, type MarkdownTheme, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../../domain/agent.js";
import type { ViewerMessage } from "../../domain/child-session.js";
import { formatAgentRow } from "../agent-row.js";

/**
 * conversation-viewer.ts — the live overlay of one agent's conversation (JW-166 port of the v1
 * viewer, trimmed): auto-updating, scrollable, Enter to steer, Esc to close, x to stop. It stays
 * open after the agent finishes so the final answer stays readable. Assistant text renders as
 * Markdown when the host supplies pi's Markdown theme.
 */

/** The overlay options every entry point opens the viewer with. */
export const VIEWER_OVERLAY = {
  overlay: true,
  overlayOptions: { anchor: "top-center", width: "100%", maxHeight: "100%" },
} as const;

/** Rows left uncovered at the bottom of the screen (pi's editor and status rows). */
export const VIEWER_BOTTOM_RESERVED_ROWS = 3;
/** Cap on one tool result before the viewer elides it. */
export const RESULT_MAX_CHARS = 4_000;
/** Top border + header + rule + footer + bottom border. */
const CHROME_LINES = 5;
const MIN_VIEWPORT = 3;

/** What the viewer reads and drives, supplied by the host. */
export interface ViewerSource {
  snapshot(): AgentSnapshot | undefined;
  messages(): ReadonlyArray<ViewerMessage>;
  onChange(listener: () => void): () => void;
  /** Resolves to the status line to show (sent, queued, or the refusal). */
  steer(message: string): Promise<string>;
  stop(): void;
}

export interface ViewerTheme {
  fg(color: string, text: string): string;
}

interface TuiLike {
  terminal?: { rows?: number };
  requestRender?(): void;
}

export class ConversationViewer {
  readonly #tui: TuiLike;
  readonly #source: ViewerSource;
  readonly #theme: ViewerTheme;
  readonly #done: () => void;
  readonly #markdown: MarkdownTheme | undefined;
  readonly #unsubscribe: () => void;
  /** Lines scrolled up from the bottom; 0 follows the tail. */
  #fromBottom = 0;
  #input: Input | undefined;
  #status = "";

  constructor(tui: TuiLike, source: ViewerSource, theme: ViewerTheme, done: () => void, markdown?: MarkdownTheme) {
    this.#tui = tui;
    this.#source = source;
    this.#theme = theme;
    this.#done = done;
    this.#markdown = markdown;
    this.#unsubscribe = source.onChange(() => this.#tui.requestRender?.());
  }

  /** True while the steer composer is open. */
  get composing(): boolean {
    return this.#input !== undefined;
  }

  handleInput(data: string): void {
    if (this.#input) {
      this.#input.handleInput(data);
      this.#tui.requestRender?.();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.#close();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.#compose();
      return;
    }
    if (data === "x") {
      this.#source.stop();
      this.#status = "Stop requested.";
    } else if (matchesKey(data, "up") || data === "k") this.#fromBottom += 1;
    else if (matchesKey(data, "down") || data === "j") this.#fromBottom = Math.max(0, this.#fromBottom - 1);
    else if (matchesKey(data, "pageUp")) this.#fromBottom += 10;
    else if (matchesKey(data, "pageDown")) this.#fromBottom = Math.max(0, this.#fromBottom - 10);
    this.#tui.requestRender?.();
  }

  render(width: number): string[] {
    const th = this.#theme;
    const inner = Math.max(10, width - 4);
    const height = Math.max(CHROME_LINES + MIN_VIEWPORT, (this.#tui.terminal?.rows ?? 30) - VIEWER_BOTTOM_RESERVED_ROWS);
    const composerLines = this.#input ? this.#input.render(inner) : [];
    const viewport = Math.max(MIN_VIEWPORT, height - CHROME_LINES - composerLines.length);
    const content = this.contentLines(inner);
    const maxFromBottom = Math.max(0, content.length - viewport);
    this.#fromBottom = Math.min(this.#fromBottom, maxFromBottom);
    const end = content.length - this.#fromBottom;
    const start = Math.max(0, end - viewport);
    const shown = content.slice(start, end);
    while (shown.length < viewport) shown.push("");

    const snap = this.#source.snapshot();
    const header = snap ? `${formatAgentRow(snap, Date.now())} · ${snap.description}` : "agent";
    const keys = this.#input ? "Enter send · Esc cancel" : "↑↓ scroll · Enter steer · x stop · Esc close";
    const footer = `${content.length === 0 ? 0 : start + 1}-${end} of ${content.length} lines · ${this.#status ? `${this.#status} · ` : ""}${keys}`;
    const box = (line: string) => th.fg("border", "│ ") + pad(truncateToWidth(line, inner), inner) + th.fg("border", " │");
    return [
      th.fg("border", `╭${"─".repeat(width - 2)}╮`),
      box(th.fg("accent", header)),
      th.fg("border", `├${"─".repeat(width - 2)}┤`),
      ...shown.map(box),
      ...composerLines.map(box),
      box(th.fg("dim", footer)),
      th.fg("border", `╰${"─".repeat(width - 2)}╯`),
    ];
  }

  /** The conversation as display lines at `width` (exported for tests through the instance). */
  contentLines(width: number): string[] {
    const th = this.#theme;
    const out: string[] = [];
    for (const message of this.#source.messages()) {
      if (message.role === "user") {
        out.push(th.fg("accent", "▍You"));
        for (const b of message.blocks) if (b.type === "text" && b.text) out.push(...wrapTextWithAnsi(b.text, width));
      } else if (message.role === "assistant") {
        for (const b of message.blocks) {
          if (b.type === "text" && b.text?.trim()) out.push(...this.#markdownLines(b.text, width));
          if (b.type === "toolCall") out.push(th.fg("muted", truncateToWidth(`⚙ ${b.name ?? "tool"} ${JSON.stringify(b.arguments ?? {})}`, width)));
        }
      } else if (message.role === "toolResult") {
        const text = message.blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
        const clipped = text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}… (truncated)` : text;
        out.push(th.fg("dim", `⎿ ${message.toolName ?? "result"}`));
        for (const line of clipped.split("\n").slice(0, 12)) out.push(...wrapTextWithAnsi(th.fg("dim", `  ${line}`), width));
      }
      out.push("");
    }
    return out;
  }

  invalidate(): void {}

  dispose(): void {
    this.#unsubscribe();
  }

  #markdownLines(text: string, width: number): string[] {
    if (!this.#markdown) return wrapTextWithAnsi(text, width);
    return new Markdown(text, 0, 0, this.#markdown, undefined, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    }).render(width);
  }

  #compose(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value) => {
      this.#input = undefined;
      const message = value.trim();
      if (!message) {
        this.#tui.requestRender?.();
        return;
      }
      this.#status = "Sending…";
      void this.#source.steer(message).then(
        (status) => {
          this.#status = status;
          this.#tui.requestRender?.();
        },
        (error: unknown) => {
          this.#status = error instanceof Error ? error.message : String(error);
          this.#tui.requestRender?.();
        },
      );
      this.#tui.requestRender?.();
    };
    input.onEscape = () => {
      this.#input = undefined;
      this.#tui.requestRender?.();
    };
    this.#input = input;
    this.#tui.requestRender?.();
  }

  #close(): void {
    this.#unsubscribe();
    this.#done();
  }
}

function pad(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
