/**
 * mention.ts — the `@handle` grammar for messaging a subagent from the prompt.
 *
 * Claude Code's grammar, reproduced so the two behave identically: suggestions fire on `@`
 * at the start of the input or after whitespace followed by `[\w-]*` (so `@src/foo.ts` is a
 * file, never an agent), and a send is recognized only at the START of the input and only
 * with a non-empty message after the handle — which is why a bare `@code-review` goes to
 * the main model rather than anywhere near the agent.
 *
 * What a handle is CALLED, and how one is allocated, is `agent/handle-registry.ts`: a record's
 * identity is a UUID plus a deliberately non-unique description, neither typeable, so handles are
 * derived from the agent type and collisions numbered (`explore`, `explore-2`), as Claude Code's
 * `allocateName` does. This module is only the syntax that carries one.
 */

/**
 * Suggestion trigger: `@` at a token boundary plus the partial handle typed so
 * far. Ported from Claude Code, including the CJK sentence-ending punctuation
 * it accepts as a boundary.
 */
export const MENTION_TRIGGER = /(^|[\s。、？！])@([\w-]*)$/;

/** Send grammar: leading `@handle`, then a non-empty message. */
const MENTION_SEND = /^@([\w-]+)\s+([\s\S]+)$/;


/**
 * Claude Code documents `@agent-<name>` as the form you type by hand when the
 * picker isn't involved. Accepted here as an exact synonym: the caller tries the
 * handle as written first, so an agent genuinely called `agent-foo` still wins
 * over `@agent-` + `foo`, and only falls back to this when that finds nothing.
 * Returns undefined when the prefix is absent or is the whole handle.
 */
export function stripAgentPrefix(handle: string): string | undefined {
  const rest = /^agent-(.+)$/i.exec(handle)?.[1];
  return rest || undefined;
}

/**
 * A spawn needs the short description every agent surface renders. A mention
 * carries no separate label, so the message itself becomes one: first line,
 * whitespace collapsed, clipped to roughly the 3-5 words the Agent tool asks of
 * the model.
 */
export function describeMention(message: string): string {
  const oneLine = message.split("\n", 1)[0].replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39).trimEnd()}…` : oneLine;
}

/**
 * What Claude Code sends the main model when a mention names an agent it could
 * start. Its `@agent-<type>` mention is not a spawn at all: it becomes an
 * `agent_mention` attachment, which renders to a synthetic `isMeta` user
 * message placed after the user's own untouched text — no tool forcing, no
 * allowed-tools narrowing, and the Task tool is not even named. The model reads
 * this and calls the tool itself.
 *
 * Ported verbatim from the 2.1.233 bundle's attachment renderer, trailing space
 * before the closing newline included, so the wording the model was trained
 * against is the wording it gets. The one substitution is ours: pi's equivalent
 * of Task is the `Agent` tool, and the agent listing that teaches valid
 * `subagent_type` values is the tool spec rather than a separate attachment.
 */
export function agentMentionReminder(type: string): string {
  return `<system-reminder>\nThe user has expressed a desire to invoke the agent "${type}". Please invoke the agent appropriately, passing in the required context to it. \n</system-reminder>`;
}

/**
 * Split `@handle message` into its parts, or null when the text isn't a send —
 * a bare handle, a leading file path, or a mention that isn't at the start.
 */
export function parseMention(text: string): { handle: string; message: string } | null {
  const match = MENTION_SEND.exec(text);
  if (!match) return null;
  const message = match[2].trim();
  return message ? { handle: match[1], message } : null;
}
