import { truncateToWidth } from "@earendil-works/pi-tui";
import { type SubagentResultDetails, SubagentResultMessage } from "../domain/subagent-result.js";
import { formatDuration, formatIdentity } from "./agent-row.js";

/**
 * result-message-view.ts — the collapsed/expanded display of a subagent-result message.
 *
 * Display only — the LLM still receives the full content. One status row per agent the message
 * carries (a smart-join group lists each), then the body.
 */

const SHOWN_LINES = 3;

export interface RenderResultOptions {
  readonly expanded: boolean;
  readonly width: number;
}

export const ResultMessageView = {
  /** Collapsed/expanded display lines, each truncated to the available width. */
  render(message: SubagentResultMessage, options: RenderResultOptions): string[] {
    const details = message.details;
    const heads = details === undefined ? ["✓ subagent"] : (details.group ?? [details]).map(statusLine);
    const body = message.content.split("\n");
    const lines = options.expanded ? [...heads, ...body] : collapse(heads, body);
    return lines.map((line) => truncateToWidth(line, options.width));
  },
};

/** `<glyph> <agent>  <model - thinking>  <tokens ctx%> · <description> · <stats>`. */
export function statusLine(d: SubagentResultDetails): string {
  const identity = formatIdentity({
    name: d.name,
    model: d.model,
    thinking: d.thinking,
    tokens: d.tokens ?? 0,
    contextPercent: d.contextPercent,
  });
  const stats = [
    ...(d.turns ? [`${d.turns} turn${d.turns === 1 ? "" : "s"}`] : []),
    `${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`,
    formatDuration(d.durationMs),
  ].join(" · ");
  return `${SubagentResultMessage.statusGlyph(d.status)} ${identity} · ${d.description} · ${stats}`;
}

function collapse(heads: readonly string[], body: readonly string[]): string[] {
  if (body.length <= SHOWN_LINES + 1) return [...heads, ...body];
  const hidden = body.length - SHOWN_LINES;
  return [...heads, ...body.slice(0, SHOWN_LINES), `… ${hidden} more lines`];
}
