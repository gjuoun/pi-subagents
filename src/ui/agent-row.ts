import type { AgentStatus } from "../domain/agent.js";

/**
 * agent-row.ts — the one row every surface draws (JW-166): the FleetView's line under the
 * editor, the Agent tool's result, the background result message and the conversation
 * viewer's identity block. Also the one status-icon table they all share.
 *
 * The shape is `[marker]<icon><clock> <name>  <description>  [<model - thinking>]  <tokens ctx%>`,
 * blank fields dropped, so a just-launched agent is just `⏳0s finder  its description`. Cost is
 * nowhere. Pure strings; the colouring is the caller's, through AgentRowOptions.paint.
 */

/** `42k`, `1.5k`, `980`, `2.1M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}

const trim = (v: number): string => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ""));

/** `<model> - <thinking>`, either half omitted when unknown; strips a `provider/` prefix. */
export function formatModel(model: string | undefined, thinking: string | undefined): string {
  const id = model?.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  if (id && thinking) return `${id} - ${thinking}`;
  return id ?? thinking ?? "";
}

/** `11s`, `1m40s`, `1h2m` — at most two units, never padded. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Context pressure at which the figure turns amber, then red. */
export const CONTEXT_WARN = 60;
export const CONTEXT_CRITICAL = 85;

/** The clock's theme colour for a status. */
export function clockColor(status: string): string {
  switch (status) {
    case "running":
      return "warning";
    case "done":
      return "success";
    case "error":
    case "aborted":
      return "error";
    default:
      return "dim";
  }
}

/** The context figure's theme colour, or `base` when there is nothing to warn about. */
export function usageColor(contextPercent: number | undefined, base: string): string {
  if (contextPercent === undefined) return base;
  if (contextPercent >= CONTEXT_CRITICAL) return "error";
  if (contextPercent >= CONTEXT_WARN) return "warning";
  return base;
}

/**
 * The one status table every surface draws from — the FleetView row, the Agent tool row, the
 * result message and the conversation viewer. Owning it here is what stops them drifting.
 */
const STATUS_ICONS: Readonly<Record<AgentStatus, string>> = {
  running: "⏳",
  done: "✅",
  error: "❌",
  aborted: "🛑",
  queued: "🕒",
};

/** The icon for a status; an unknown status reads as running. */
export function statusIcon(status: string): string {
  return STATUS_ICONS[status as AgentStatus] ?? STATUS_ICONS.running;
}

/** What one row is built from — `AgentSnapshot` and `SubagentResultDetails` both satisfy it. */
export interface AgentRowFields {
  readonly name: string;
  readonly status: string;
  readonly description?: string;
  /** A delivered result carries its duration; a live row is measured from its start. */
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly tokens?: number;
  readonly contextPercent?: number;
  readonly model?: string;
  readonly thinking?: string;
}

/** Which piece of the row a painter is handed. */
export type AgentRowPart = "marker" | "icon" | "clock" | "name" | "description" | "model" | "tokens" | "ctx";

export interface AgentRowOptions {
  /** `●`/`○` — the FleetView's selection marker, absent everywhere else. */
  readonly marker?: string;
  /** Add `<model - thinking>` before the usage. The conversation viewer is the only caller. */
  readonly model?: boolean;
  /** Set false to leave the description out, for a caller that draws it on its own line. */
  readonly description?: boolean;
  /** Style one piece. The caller supplies the colours; this file owns the order. */
  readonly paint?: (part: AgentRowPart, text: string) => string;
}

/** The row's three pieces, painted. Split so a caller can fit them to a width first. */
export interface AgentRowParts {
  readonly lead: string;
  readonly middle: string;
  readonly usage: string;
}

/** The row's pieces, painted — `lead`, the description and optional model, then the usage. */
export function agentRowParts(fields: AgentRowFields, now: number, options: AgentRowOptions = {}): AgentRowParts {
  const paint = options.paint ?? ((_part: AgentRowPart, text: string) => text);
  const elapsed = fields.durationMs ?? (fields.finishedAt ?? now) - (fields.startedAt ?? now);
  const lead =
    (options.marker === undefined ? "" : paint("marker", options.marker)) +
    paint("icon", statusIcon(fields.status)) +
    paint("clock", formatElapsed(elapsed)) +
    " " +
    paint("name", fields.name);
  const middle: string[] = [];
  if (options.description !== false && fields.description !== undefined && fields.description !== "") {
    middle.push(paint("description", fields.description));
  }
  if (options.model) {
    const model = formatModel(fields.model, fields.thinking);
    if (model !== "") middle.push(paint("model", model));
  }
  const usage: string[] = [];
  if ((fields.tokens ?? 0) > 0) usage.push(paint("tokens", formatTokens(fields.tokens as number)));
  if (fields.contextPercent !== undefined) usage.push(paint("ctx", `${Math.round(fields.contextPercent)}%`));
  return { lead, middle: middle.join("  "), usage: usage.join(" ") };
}

/**
 * The one row: `[marker]<icon><clock> <name>  <description>  [<model - thinking>]  <tokens ctx%>`.
 * Every field but the name is optional, and a blank one is dropped rather than left as a gap.
 */
export function formatAgentRow(fields: AgentRowFields, now: number, options: AgentRowOptions = {}): string {
  const { lead, middle, usage } = agentRowParts(fields, now, options);
  return [lead, middle, usage].filter((part) => part !== "").join("  ");
}
