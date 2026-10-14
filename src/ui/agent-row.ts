import type { AgentSnapshot } from "../domain/agent.js";

/**
 * agent-row.ts — the one-line identity of an agent, shared by every surface (JW-166):
 * `<agent> <model - thinking> <tokens ctx%>`. No cost anywhere. Pure strings; colouring is
 * the caller's.
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

/** `<tokens> <ctx>%`; tokens omitted at 0, ctx omitted when unknown. */
export function formatUsage(tokens: number, contextPercent: number | undefined): string {
  const parts: string[] = [];
  if (tokens > 0) parts.push(formatTokens(tokens));
  if (contextPercent !== undefined) parts.push(`${Math.round(contextPercent)}%`);
  return parts.join(" ");
}

/** `1.2s`, `3m 4s`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** `<agent>  <model - thinking>  <tokens ctx%>` — blank fields dropped. */
export function formatIdentity(s: Pick<AgentSnapshot, "name" | "model" | "thinking" | "tokens" | "contextPercent">): string {
  return [s.name, formatModel(s.model, s.thinking), formatUsage(s.tokens, s.contextPercent)]
    .filter((p) => p !== "")
    .join("  ");
}

/** Turns, tool uses and duration: `3 turns · 2 tool uses · 1.2s`. */
export function formatStats(s: Pick<AgentSnapshot, "turns" | "toolUses" | "startedAt" | "finishedAt">, now: number): string {
  const parts: string[] = [];
  if (s.turns > 0) parts.push(`${s.turns} turn${s.turns === 1 ? "" : "s"}`);
  if (s.toolUses > 0) parts.push(`${s.toolUses} tool use${s.toolUses === 1 ? "" : "s"}`);
  parts.push(formatDuration((s.finishedAt ?? now) - s.startedAt));
  return parts.join(" · ");
}

/** The status glyph of the transcript surfaces (tool row, result message). */
export function statusGlyph(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "aborted":
      return "■";
    case "queued":
      return "…";
    default:
      return "⠋";
  }
}

/** The Agent tool row: `<glyph> <identity> · <stats>`. */
export function formatAgentRow(s: AgentSnapshot, now: number): string {
  return `${statusGlyph(s.status)} ${formatIdentity(s)} · ${formatStats(s, now)}`;
}
