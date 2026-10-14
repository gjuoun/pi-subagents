import type { AgentType } from "./agent-type.js";

/**
 * fork.ts — the branched subagent (JW-166, Claude Code's buildForkedMessages design).
 *
 * `subagent_type: "fork"` continues the main thread's real conversation: the child session is
 * the parent's active branch, the parent's in-flight assistant message (every tool call kept),
 * one identical placeholder result per tool call, then this directive as the first prompt.
 * Same model, thinking, tools and prompt as the parent so the provider's prompt cache is reused.
 */

export const FORK_TYPE = "fork";

/** The pseudo agent type a fork runs as (not an agent file). */
export const FORK_AGENT_TYPE: AgentType = {
  name: FORK_TYPE,
  description: "Fork of the main conversation",
  systemPrompt: "",
  skills: true,
  enabled: true,
};

/** The text every in-flight tool call of the parent's turn gets as its result in the fork. */
export const FORK_PLACEHOLDER = "Fork started — processing in background";

/** The tag that marks a fork's transcript (and lets a fork refuse to fork). */
export const FORK_DIRECTIVE_TAG = "fork_directive";

/** What a fork's subagent tools answer: forks do the work themselves. */
export const FORK_REFUSAL = "Fork is not available inside a forked worker. Complete your task directly using your tools.";

/** The fork's first prompt: worker boilerplate around the main agent's directive. */
export function forkDirective(prompt: string): string {
  return [
    `<${FORK_DIRECTIVE_TAG}>`,
    "You are a worker fork of the conversation above. You are NOT a continuation of that agent: do not address the user and do not pick up its other plans.",
    "Execute ONE directive, then stop. Do the work with your tools and end with a concise report of what you did and found (list any files you changed).",
    "Do not start subagents — you ARE the fork.",
    "",
    "Directive:",
    prompt,
    `</${FORK_DIRECTIVE_TAG}>`,
  ].join("\n");
}

/** Where a fork's conversation comes from. */
export interface ForkSource {
  /** The parent's session file (a fork needs one). */
  readonly parentFile: string;
  /** The parent's leaf entry: the assistant message holding this Agent call. */
  readonly leafId: string;
  /** The parent's active tool names, declared identically in the fork. */
  readonly activeTools: ReadonlyArray<string>;
  /** The parent's addendum section content, reproduced in the fork's prompt. */
  readonly addendum?: string;
}
