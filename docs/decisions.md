# Decisions recorded in code

Contributor-facing. Some guards and defaults in `src/` exist because of one specific bug report, and
the comment next to them is the only record of *why* — the CHANGELOG states what a release changed, not
what the code has to keep doing. This file holds that record, so trimming the prose around a decision
does not delete the decision.

One entry per issue: the decision it produced, the reasoning that would otherwise be lost, and where
the decision is frozen in the source. JW-166 replaced the old core; only the entries whose guard
survived are kept, restated for the current tree.

## #183 — Reject unknown or disabled agent types

**Decision.** An Agent call names its type explicitly (`subagent_type` is required) and the type
must resolve to an enabled agent file. There is no built-in fallback agent: an unknown or
`enabled: false` type fails with `Error [UnknownAgentType]`, listing the available types. A
`resume` reuses the agent it resumes and never re-resolves a type.

**Why.** Substituting a default agent for an unresolvable type silently ran a different agent, model
and tool policy — and for a background call, execution began before the caller saw any sign of it. A
disabled agent that still resolved ran with a mixed identity.

**Where.** `src/services/agent-type-catalog.ts` (`resolve`, the `enabled` filter),
`src/pi/agent-tool.ts` (`subagent_type` required, the single dispatch point).

## #210 — Render Markdown in the conversation viewer

**Decision.** Assistant prose renders as Markdown; tool results stay verbatim (dimmed, clipped). The
switch that used to choose between modes is gone — this is the old `assistant` default, hard-coded.

**Why.** Assistant text *is* Markdown by contract, while a tool result is arbitrary bytes: a Markdown
pass over a log or a diff eats `#` from shell comments, swallows a `---` line into a heading and redraws
`| a | b |` as a table. Ordered-list renumbering and backslash normalisation are suppressed even for
prose, because they change content rather than layout.

**Where.** `src/ui/viewer/conversation-viewer.ts` (`#markdownLines` and its Markdown options),
`src/index.ts` (`piMarkdownTheme`, which falls back to plain text when pi has no theme).
