# Decisions recorded in code

Some guards, defaults and type shapes in `src/` exist because of one specific bug report, and the
comment next to them is the only record of *why* — the CHANGELOG states what a release changed, not
what the code has to keep doing. This file holds that record, so trimming the prose around a decision
does not delete the decision.

One entry per issue: the decision it produced, the reasoning that would otherwise be lost, and where
the decision is frozen in the source. All eight issues are closed; the code is the current answer.

## #38 — Token count inside of the overlay is incorrect

**Decision.** The *display* total (`getLifetimeTotal`, `AgentRecord.lifetimeUsage`, and `tokens` in
the `subagents:completed`/`subagents:failed` payload) excludes `cacheRead` and is built from a
lifetime accumulator fed by `message_end` events rather than from `session.state.messages`.

**Why.** Two bugs in one field. Upstream `getSessionStats().tokens.total` sums per-turn `cacheRead`
across every assistant message, but each turn's `cacheRead` is the *cumulative* cached prefix re-read
on that one call — summing N turns counts the prefix N times. And anything derived from
`session.state.messages` resets at compaction, because upstream replaces the array. The accumulator is
independent of that mutation, so it survives compaction; total = input + output + cacheWrite by
construction.

The exclusion is about display, not about what was billed: the prefix really is re-read and re-charged
on every call. So `cacheRead` is accumulated anyway, kept out of `getLifetimeTotal`, and used where
billing is the question — `reportUsage`, which hands the run's spend to the parent session as pi's own
`Usage` shape. pi counts the parent's own messages the same way, and reporting 0 there would make a
subagent's rows count differently from every other row in one total.

**Where.** `src/lib/usage.ts` (`LifetimeUsage`, `getLifetimeTotal`, `addUsage`), `src/lib/types.ts`
(`AgentRecord.lifetimeUsage`), `src/index.ts` (`buildEventData`).

## #118 — Foreground agent status can render twice and leave stale rows

**Decision.** `widgetMode` defaults to `background`, which hides agents *known* to be foreground from
the persistent above-editor widget. Filtering keys off the tri-state `AgentRecord.isBackground`
captured at spawn (`true` = background, `false` = foreground, `undefined` = undeclared), not off the
UI-only `invocation` snapshot.

**Why.** A foreground agent already renders inline as the `Agent` tool result, so listing it in the
widget too rendered the same run twice — most visible in tmux/zellij. Keying off `isBackground` keeps
scheduler-, RPC- and mention-spawned background agents visible: only runs *known* to be foreground are
dropped.

**Where.** `src/lib/types.ts` (`WidgetMode`), `src/config/settings.ts` (`SubagentsSettings.widgetMode`),
`src/index.ts` (the widget's default and its spawn-time `isBackground` capture).

## #142 — Filtered-out pi-subagents still advertises and answers RPC

**Decision.** The `subagents:rpc:*` handlers and the `subagents:ready` broadcast are registered on the
first bound `session_start`, deliberately not at factory time.

**Why.** pi runs every extension factory *before* applying an agent's `extensions:` filter and only
delivers lifecycle events to the survivors, but the `pi.events` bus is shared with the filtered-out
activations too. Registering at factory time made a child session whose `extensions:` omitted
pi-subagents advertise a spawn service it could never provide: `ping` succeeded and every `spawn`
answered `No active session`, because its `session_start` never fired and there was no context.
Gating on the bound event makes a filtered session behave like an absent one. Emitting readiness after
all factories have loaded also closes a latent race where a consumer whose factory ran after ours
could miss the event. Sessions that do load the extension are unaffected — both just happen at
`session_start` now.

**Where.** `src/index.ts` (the registration block and the `session_start` handler). Documented in
`docs/rpc.md`.

## #183 — Add an option to reject unknown or disabled agent types

**Decision.** Resolution happens at one point shared by every caller-supplied spawn — the `Agent` tool,
the scheduler at fire time, cross-extension RPC and nested delegation — and requires the type to
resolve to exactly one *enabled* agent. `fallbackSubagent` decides what an unresolvable type does:
omitted keeps `general-purpose`, any enabled agent name routes there, `none` (or `false`) fails closed
with an error listing the available types. An explicitly configured fallback that is itself unknown or
disabled is reported as the misconfiguration it is. Case-ambiguous names count as unresolvable. Nested
delegation keeps rejecting unconditionally whatever the setting says, so a project-level fallback
cannot hand a nested caller an agent outside its allowlist. A `resume` must not inherit the fallback:
reopening this conversation under a different agent's prompt and tools is not continuing it, and the
new record would re-tombstone under the substitute so the handle would never find its way back.

**Why.** Dispatch used to repair every unresolvable type by substituting `general-purpose`, so a typo
silently ran a different agent, model and tool policy — and for a background or scheduled call,
execution began before the caller saw any indication. Separately, `resolveType()` reported a canonical
name without checking `enabled`, so a disabled agent resolved successfully and then split downstream:
its own config built the system prompt while `getConfig` returned general-purpose for tools,
extensions, skills and prompt mode — one run with a mixed identity.

The `Agent` tool's fallback is deliberately unchanged: #183 asks for it to remain the default, and the
pre-existing hole it leaves (an unregistered `general-purpose` resolving to the hardcoded all-tools
tier) is what `fallbackSubagent: none` is for, not something to close under everyone silently.

**Where.** `src/config/registry/agent-types.ts` (`resolveSpawnType` and its final default),
`src/tools/agent.ts` (the single dispatch decision point), `src/index.ts` (`spawnResolved` and the
resume path).

## #210 — Render Markdown in the conversation viewer

**Decision.** `viewerMarkdown` — `off` | `assistant` | `all` — is the one switch. The default renders
assistant prose as Markdown and leaves tool results verbatim; `all` renders tool results too.

**Why.** Assistant text *is* Markdown by contract, while a tool result is arbitrary bytes: a Markdown
pass over a log or a diff eats `#` from shell comments, swallows a `---` line into a setext heading,
re-fences indented output and redraws `| a | b |` as a table. Ordered-list renumbering is the one such
rewrite actively suppressed (see `MARKDOWN_OPTIONS`), because it silently changes data rather than
layout. `all` is for tools that genuinely emit Markdown, accepting the rewrites on ones that don't.

**Where.** `src/lib/types.ts` (`ViewerMarkdownMode`), `src/config/settings.ts`,
`src/ui/viewer/` (the render path and `MARKDOWN_OPTIONS`).

## #231 — Models pass `isolation: "worktree"` even when instructed to omit it

**Decision.** `isolation` accepts `"off"`, listed first and described as the default. In tool calls
that value is an input spelling only — `resolveAgentInvocationConfig` collapses it to `undefined`, so
nothing downstream sees anything but `"worktree"`. In an agent file it is a genuine veto, since agent
config outranks tool-call parameters.

**Why.** As a single-value optional literal, `isolation` was the one optional parameter whose only
expressible value had an expensive side effect, while every other optional field has an inert filler —
the session log on #231 shows one model emitting `resume: ""`, `schedule: ""` and `model: "default"`
alongside it. It had nothing to fill the field with, so it kept spawning worktrees across three turns
while its own reasoning said to omit the field. `"off"` is the harmless value, and being legal is what
lets a model decline one. The parameter description also carries the uncommitted-work warning — a
worktree cannot see staged or uncommitted work, the specific trap here. Deliberately absent is any
"only use a worktree when…" restriction: Claude Code's `Agent` tool states the capability and stops.

**Where.** `src/agent/invocation.ts` (the whole parameter shape and its description),
`src/lib/types.ts` (`IsolationMode`), `src/ui/agents/create-wizard.ts` (the field is only offered on a
project where worktree isolation is enabled, so a wizard-created file cannot bake in a request that is
refused at spawn time).

## #242 — `bindExtensions()` on child sessions has no matching `session_shutdown`

**Decision.** `runAgent` opens the extension lifecycle with `bindExtensions`, so the matching
`session_shutdown` must be emitted before the session is disposed — on eviction and on quit, awaited,
bounded at three seconds per session.

**Why.** `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()`; pi emits the event itself in
`AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds extensions onto a
session without going through that path. Without the emit, whatever an extension armed in
`session_start` — timers, fs watchers, sockets, temp dirs — leaked once per spawn, and the 10-minute
record sweep turned the leak into a crash: disposing invalidated the runner while a leaked timer was
still armed, so its next tick threw `assertActive()` from a bare callback, an `uncaughtException` that
took interactive pi down with it. Quit waits for those handlers because pi awaits the handler and the
process exits right after — unawaited, they would never run.

**Where.** `src/agent/agent-manager.ts` (`shutdownChildSession`, and the eviction sweep),
`src/index.ts` (the `session_shutdown` handler).

## #253 — `maxConcurrent` is ignored for foreground subagents

**Decision.** `maxConcurrentForeground` — default `0` = unlimited — is a second, independent
concurrency pool for blocking `Agent` calls. Nested children, detached spawns from cross-extension RPC
or `@handle` mentions, and foreground `resume` are all outside it.

**Why.** pi dispatches a message's tool calls through `Promise.all`, so an unqualified fan-out of
blocking `Agent` calls has always run all at once — expensive rather than fast on local models, where
parallel agents thrash the prompt cache. It is deliberately not folded into `maxConcurrent`: a
foreground agent blocks the parent anyway, so charging it to the background pool would let a saturated
pool starve the main session of work it could have done itself. Nested children are exempt because
their parent is blocked *awaiting them*, so queueing a child behind its own parent would deadlock;
detached spawns block nobody and are documented to start immediately; foreground `resume` reuses an
existing session and never reaches the spawn path, so several blocking resumes in one message can
still exceed the limit.

**Where.** `src/config/settings.ts` (`SubagentsSettings.maxConcurrentForeground`),
`src/agent/agent-manager.ts` (`DEFAULT_MAX_CONCURRENT_FOREGROUND` and the foreground pool).
Documented in `README.md`.
