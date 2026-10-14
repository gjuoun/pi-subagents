import { handleBase, RESERVED_HANDLES } from "./handle.js";

/**
 * mention.ts — the `@handle` grammar and what a mention turns into (JW-166).
 *
 * Claude Code's behaviour: a leading `@handle message` stays a message to the MAIN model, with
 * a <system-reminder> appended naming the agent the user wants; the main model makes the
 * Agent (or steer_subagent) call itself. `@main message` strips the prefix. Grammar ported
 * from the v1 core (src/agent/mention/mention.ts).
 */

/** Suggestion trigger: `@` at a token boundary plus the partial handle typed so far. */
export const MENTION_TRIGGER = /(^|[\s。、？！])@([\w-]*)$/;

/** Send grammar: leading `@handle`, then a non-empty message. */
const MENTION_SEND = /^@([\w-]+)\s+([\s\S]+)$/;

/** Split `@handle message` into its parts, or null when the text isn't a send. */
export function parseMention(text: string): { handle: string; message: string } | null {
  const match = MENTION_SEND.exec(text);
  if (!match) return null;
  const message = match[2].trim();
  return message ? { handle: match[1], message } : null;
}

/** Claude Code's reminder for a mentioned agent type, verbatim (trailing space included). */
export function agentMentionReminder(type: string): string {
  return `<system-reminder>\nThe user has expressed a desire to invoke the agent "${type}". Please invoke the agent appropriately, passing in the required context to it. \n</system-reminder>`;
}

/** The reminder for a mentioned agent that already exists. */
export function liveMentionReminder(agent: LiveAgent): string {
  const action =
    agent.status === "running" || agent.status === "queued"
      ? `It is ${agent.status}: relay the message to it with steer_subagent (agent_id "${agent.handle}").`
      : `It has finished: continue it with the Agent tool's resume parameter (resume "${agent.id}") and the message as the prompt.`;
  return `<system-reminder>\nThe user addressed the existing ${agent.type} agent "${agent.handle}" (id ${agent.id}). ${action}\n</system-reminder>`;
}

export interface LiveAgent {
  readonly id: string;
  readonly handle: string;
  readonly type: string;
  readonly status: string;
  readonly description: string;
}

export interface MentionRoster {
  readonly live: ReadonlyArray<LiveAgent>;
  readonly types: ReadonlyArray<{ readonly name: string; readonly description: string }>;
}

/** Claude Code's `@agent-<name>` spelling, accepted as a synonym. */
function stripAgentPrefix(handle: string): string | undefined {
  return /^agent-(.+)$/i.exec(handle)?.[1] || undefined;
}

/**
 * What the main model receives for a typed line, or undefined to leave it untouched: a live
 * handle wins over a type of the same name, and the handle as typed wins over `agent-`.
 */
export function transformMention(text: string, roster: MentionRoster): string | undefined {
  const mention = parseMention(text);
  if (!mention) return undefined;
  const handle = mention.handle.toLowerCase();
  if (RESERVED_HANDLES.has(handle)) return mention.message;
  for (const candidate of [handle, stripAgentPrefix(handle)?.toLowerCase()]) {
    if (candidate === undefined) continue;
    const live = roster.live.find((a) => a.handle === candidate || a.id === candidate);
    if (live) return `${mention.message}\n\n${liveMentionReminder(live)}`;
    const type = roster.types.find((t) => handleBase(t.name) === candidate);
    if (type) return `${mention.message}\n\n${agentMentionReminder(type.name)}`;
  }
  return undefined;
}

export interface MentionItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/** Completion rows for the `@…` token under the cursor: live agents first, then types. */
export function mentionItems(
  roster: MentionRoster,
  line: string,
  cursorCol: number,
): { readonly items: ReadonlyArray<MentionItem>; readonly prefix: string } | null {
  const match = MENTION_TRIGGER.exec(line.slice(0, cursorCol));
  if (!match) return null;
  const typed = match[2].toLowerCase();
  const items: MentionItem[] = [];
  const taken = new Set<string>();
  for (const a of roster.live) {
    taken.add(a.handle);
    if (!a.handle.startsWith(typed)) continue;
    const action = a.status === "running" || a.status === "queued" ? "send message" : "resume";
    items.push({ value: `@${a.handle}`, label: `@${a.handle}`, description: `${action} · ${a.status} · ${a.description}` });
  }
  for (const t of roster.types) {
    const h = handleBase(t.name);
    if (taken.has(h) || !h.startsWith(typed)) continue;
    taken.add(h);
    items.push({ value: `@${h}`, label: `@${h}`, description: `start agent · ${summarize(t.description)}` });
  }
  return items.length > 0 ? { items, prefix: `@${match[2]}` } : null;
}

/** First sentence of a description, clipped. */
function summarize(description: string): string {
  const first = (description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description).replace(/\s+/g, " ").trim();
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}
