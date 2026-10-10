import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentResultDetails } from "../notify.js";

/**
 * result-message.ts — the pure renderer for a subagent-result custom message.
 *
 * Display only: the LLM still receives the full `content`; this only decides how many
 * lines the TUI shows. Each line is truncated to the available width.
 */

const SHOWN_LINES = 3;

export interface RenderResultOptions {
  readonly expanded: boolean;
  readonly width: number;
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "aborted":
      return "■";
    default:
      return "·";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusLine(details: SubagentResultDetails | undefined): string {
  if (details === undefined) return "✓ subagent";
  return `${statusGlyph(details.status)} ${details.name} · ${details.description} · ${details.toolUses} tools · ${formatDuration(details.durationMs)}`;
}

export function renderResultMessage(
  details: SubagentResultDetails | undefined,
  content: string,
  options: RenderResultOptions,
): string[] {
  const head = statusLine(details);
  const body = content.split("\n");
  const lines = options.expanded ? [head, ...body] : collapse(head, body);
  return lines.map((line) => truncateToWidth(line, options.width));
}

function collapse(head: string, body: readonly string[]): string[] {
  if (body.length <= SHOWN_LINES + 1) return [head, ...body];
  // The three shown lines plus the status line occupy four rows; the rest are hidden.
  const hidden = body.length - SHOWN_LINES - 1;
  return [head, ...body.slice(0, SHOWN_LINES), `… ${hidden} more lines`];
}
