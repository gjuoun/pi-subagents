import { truncateToWidth } from "@earendil-works/pi-tui";
import { type SubagentResultDetails, SubagentResultMessage } from "../domain/subagent-result.js";

/**
 * result-message-view.ts — the collapsed/expanded display of a subagent-result message.
 *
 * Display only — the LLM still receives the full content. The renderer and the widget share
 * the one-glyph status marker.
 */

const SHOWN_LINES = 3;

export interface RenderResultOptions {
  readonly expanded: boolean;
  readonly width: number;
}

export class ResultMessageView {
  /** Collapsed/expanded display lines, each truncated to the available width. */
  static render(message: SubagentResultMessage, options: RenderResultOptions): string[] {
    const head = statusLine(message.details);
    const body = message.content.split("\n");
    const lines = options.expanded ? [head, ...body] : collapse(head, body);
    return lines.map((line) => truncateToWidth(line, options.width));
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusLine(details: SubagentResultDetails | undefined): string {
  if (details === undefined) return "✓ subagent";
  return `${SubagentResultMessage.statusGlyph(details.status)} ${details.name} · ${details.description} · ${details.toolUses} tools · ${formatDuration(details.durationMs)}`;
}

function collapse(head: string, body: readonly string[]): string[] {
  if (body.length <= SHOWN_LINES + 1) return [head, ...body];
  // The three shown lines plus the status line occupy four rows; the rest are hidden.
  const hidden = body.length - SHOWN_LINES - 1;
  return [head, ...body.slice(0, SHOWN_LINES), `… ${hidden} more lines`];
}
