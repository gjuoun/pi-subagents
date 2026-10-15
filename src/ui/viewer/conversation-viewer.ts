import { Input, Markdown, type MarkdownTheme, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../../domain/agent.js";
import type { ViewerMessage } from "../../domain/child-session.js";
import { agentFrame, resolveAgentColor } from "../agent-color.js";
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

/** Both borders, the rule, the footer line, the description and the identity row. */
const CHROME_LINES = 6;
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
    // One full-screen frame: nothing sits under it, and the agent's identity sits IN it.
    const height = Math.max(CHROME_LINES + MIN_VIEWPORT, this.#tui.terminal?.rows ?? 30);
    const composerLines = this.#input ? this.#input.render(inner) : [];
    const viewport = Math.max(MIN_VIEWPORT, height - CHROME_LINES - composerLines.length);
    const content = this.contentLines(inner);
    const maxFromBottom = Math.max(0, content.length - viewport);
    this.#fromBottom = Math.min(this.#fromBottom, maxFromBottom);
    const end = content.length - this.#fromBottom;
    const start = Math.max(0, end - viewport);
    const shown = content.slice(start, end);
    // The conversation rests on the identity block and grows upward: the slack is above it.
    const rows = [...Array.from({ length: Math.max(0, viewport - shown.length) }, () => ""), ...shown];

    const snap = this.#source.snapshot();
    const keys = this.#input ? "Enter send · Esc cancel" : "↑↓ scroll · Enter steer · x stop · Esc close";
    const footer = `${content.length === 0 ? 0 : start + 1}-${end} of ${content.length} lines · ${this.#status ? `${this.#status} · ` : ""}${keys}`;
    // The frame reads as that agent's overlay before a word of it is read; an agent with no
    // (or an unusable) colour keeps exactly the theme tokens it always used.
    const color = resolveAgentColor(snap?.color);
    const frame = (text: string, kind: "border" | "accent" = "border") =>
      color === undefined ? th.fg(kind, text) : agentFrame(text, color);
    const box = (line: string) => frame("│ ") + pad(truncateToWidth(line, inner), inner) + frame(" │");
    return [
      frame(`╭${"─".repeat(width - 2)}╮`),
      ...rows.map(box),
      ...composerLines.map(box),
      frame(`├${"—".repeat(width - 2)}┤`),
      box(th.fg("dim", footer)),
      box(th.fg("dim", snap?.description ?? "")),
      box(snap === undefined ? "agent" : formatAgentRow(snap, Date.now(), { model: true, description: false })),
      frame(`╰${"─".repeat(width - 2)}╯`),
    ];
  }

  /** The conversation as display lines at `width` (exported for tests through the instance). */
  contentLines(width: number): string[] {
    const th = this.#theme;
    const out: string[] = [];
    // A call waiting for its result. `ViewerMessage` carries no call id, so a result answers
    // the oldest unanswered call — the order the model made them in.
    const pending: { line: number; name: string; args: unknown }[] = [];
    for (const message of this.#source.messages()) {
      if (message.role === "user") {
        out.push(th.fg("accent", "▍You"));
        for (const b of message.blocks) if (b.type === "text" && b.text) out.push(...wrapTextWithAnsi(th.fg("text", b.text), width));
      } else if (message.role === "assistant") {
        for (const b of message.blocks) {
          if (b.type === "text" && b.text?.trim()) out.push(...this.#markdownLines(b.text, width));
          if (b.type === "toolCall") {
            pending.push({ line: out.length, name: b.name ?? "tool", args: b.arguments });
            out.push(this.#toolLine("⏳", b.name ?? "tool", b.arguments, width));
          }
        }
      } else if (message.role === "toolResult") {
        // The result body is not drawn: the line becomes the call's ✅ summary in place.
        const call = pending.shift();
        if (call !== undefined) out[call.line] = this.#toolLine("✅", call.name, call.args, width);
      }
      out.push("");
    }
    return out;
  }

  /** One tool use — `<mark><tool>: <one-line args>`, bright, cut to the width. */
  #toolLine(mark: string, name: string, args: unknown, width: number): string {
    const args_ = args === undefined ? "" : (JSON.stringify(args) ?? "");
    const one = args_.replace(/\s+/g, " ").trim();
    const text = one === "" || one === "{}" ? `${mark}${name}` : `${mark}${name}: ${one}`;
    return this.#theme.fg("text", truncateToWidth(text, width));
  }

  invalidate(): void {}

  dispose(): void {
    this.#unsubscribe();
  }

  #markdownLines(text: string, width: number): string[] {
    // Prose reads bright — the theme's plain text colour — while keeping its own formatting.
    const style = { color: (t: string) => this.#theme.fg("text", t) };
    if (!this.#markdown) return wrapTextWithAnsi(this.#theme.fg("text", text), width);
    return new Markdown(text, 0, 0, this.#markdown, style, {
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
