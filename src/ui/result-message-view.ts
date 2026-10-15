import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentResultDetails, SubagentResultMessage } from "../domain/subagent-result.js";
import { formatAgentRow } from "./agent-row.js";

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

/** The unified row over a delivered result — `<icon><clock> <agent>  <description>  <tokens ctx%>`. */
export function statusLine(d: SubagentResultDetails): string {
  return formatAgentRow(d, Date.now());
}

function collapse(heads: readonly string[], body: readonly string[]): string[] {
  if (body.length <= SHOWN_LINES + 1) return [...heads, ...body];
  const hidden = body.length - SHOWN_LINES;
  return [...heads, ...body.slice(0, SHOWN_LINES), `… ${hidden} more lines`];
}
