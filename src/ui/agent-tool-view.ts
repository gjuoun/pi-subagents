import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../domain/agent.js";
import { formatAgentRow } from "./agent-row.js";

/**
 * agent-tool-view.ts — how an Agent tool call and its result render in the transcript.
 *
 * Call: `▸ <type>  <description>`. Result: the unified agent row and the first line of the
 * answer (all of it when expanded).
 */

interface CallArgs {
  readonly subagent_type?: string;
  readonly description?: string;
}

/** Plain lines of the call line (exported for tests). */
export function agentCallLine(args: CallArgs): string {
  const type = args.subagent_type ?? "agent";
  return args.description ? `▸ ${type}  ${args.description}` : `▸ ${type}`;
}

/** Plain lines of a result (exported for tests). */
export function agentResultLines(text: string, details: AgentSnapshot | undefined, expanded: boolean, now: number): string[] {
  const body = text.split("\n");
  const preview = expanded ? body : body.slice(0, 1).map((l) => `⎿  ${l}`);
  return details === undefined ? preview : [formatAgentRow(details, now), ...preview];
}

const isSnapshot = (value: unknown): value is AgentSnapshot =>
  typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" && "status" in value;

export function renderAgentCall(args: CallArgs, theme: Theme): Component {
  return new Text(theme.fg("toolTitle", agentCallLine(args)), 0, 0);
}

export function renderAgentResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  const details = isSnapshot(result.details) ? result.details : undefined;
  const lines = agentResultLines(text, details, options.expanded, Date.now());
  return new Text(lines.map((l, i) => (i === 0 && details ? l : theme.fg("dim", l))).join("\n"), 0, 0);
}
