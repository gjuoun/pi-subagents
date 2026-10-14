# Architecture — the `src/` tree

Contributor-facing: where each piece of the extension lives, the layer rules that keep it that way, and
what each file is for. `test/layout.test.ts` enforces the rules; a structural change updates both.

`src/` is about 3.9k lines of Effect v4 (JW-166 replaced a 22.9k-line core with it).

## Layers

| Layer | Holds | May import |
|---|---|---|
| `domain/` | Pure values and rules: agent state, agent types, errors, the mention grammar, the tools rule, the fork recipe | `effect`, `domain/` |
| `services/` | Effect class services built by their own `make`, each declaring its dependencies | `effect`, `node:*`, `domain/`, `services/`; pi packages type-only |
| `pi/` | The only users of the pi SDK at runtime: tools, the child-session factory, the input hook, `/agents` | anything except `ui/` |
| `ui/` | Renderers and the FleetView / viewer components; pi's UI is reached through structural ports | `effect`, `pi-tui`, `domain/`, `services/`, `ui/`; pi-coding-agent type-only |
| root | `layers.ts` (the one composition root) and `index.ts` (registration and session wiring) | anything |

The one Effect-to-pi crossing for tools is `pi/boundary.ts` (`runTool`): an Exit becomes a tool result,
a typed error becomes `Error [<Tag>]: <message>`, a defect is re-thrown. Expected failures live in
`domain/errors.ts` as tagged enums; nothing throws for them.

## Runtime shape

One `ManagedRuntime` per pi session (`layers.ts`), disposed on `session_shutdown`, which aborts and
disposes every child. Child sessions are created inside an `AsyncLocalStorage` marker
(`pi/pi-child-session.ts`) so the extension, loaded again for each child, does not register itself
there.

## Files

### domain/
- `agent.ts` — one subagent: its child session, its published `AgentSnapshot`, `run` (busy guard, settle as done / error / aborted), `steer`, `markQueued`.
- `agent-type.ts` — the agent-file value (9 fields) and its frontmatter parser.
- `child-session.ts` — the `ChildSession` port, `SpawnSpec`, the wrap-up message and `graceTurns`.
- `errors.ts` — Session / Registry / Catalog tagged errors and their renderers.
- `fork.ts` — the fork pseudo type, placeholder, refusal and directive text, `ForkSource`.
- `handle.ts` — handle slugs and collision numbering.
- `mention.ts` — the `@handle` grammar, the reminder text, completion rows.
- `subagent-result.ts` — the completion message value, single or grouped.
- `tool-selection.ts` — the tools rule (omitted = everything; `ext:` selectors; subagent tools withheld).

### services/
- `agent-registry.ts` — the agents, their snapshots (a `SubscriptionRef`), the background pool and queue, handles, `awaitSettled`.
- `agent-type-catalog.ts` — agent files from `<agentDir>/agents` then `<cwd>/.pi/agents` (project wins), `enabled` filter.
- `group-join.ts` — the smart join: batching by parent turn, group timeouts, solo hold, consumed results.
- `settings.ts` — `maxConcurrent` from `~/.pi/eyu/subagents.json` then `<cwd>/.pi/subagents.json` (project wins, default 10).
- `parent-context.service.ts` — the per-call view of the parent session.
- `session-factory.ts`, `result-notifier.ts`, `id-generator.ts` — ports the live layers fill.
- `e2e-handle.ts` — the `Symbol.for("pi-subagents:v2")` handle the faux-model tests wait on.

### pi/
- `agent-tool.ts` — the `Agent` tool and the per-call `ParentContext` (including the fork's view of the parent).
- `get-result-tool.ts`, `steer-tool.ts` — the other two tools.
- `pi-session-factory.ts` — child sessions: the pil-style prompt, exact model, tools rule, and the fork branch.
- `pi-child-session.ts` — one child turn: answer, usage, turn cap and wrap-up, conversation for the viewer.
- `pi-result-notifier.ts` — completion messages as follow-ups that trigger a parent turn.
- `mention-hook.ts` — the `input` hook that appends the mention reminder.
- `agents-command.ts` — `/agents`.
- `boundary.ts` — `runTool`.

### ui/
- `agent-row.ts` — the shared identity line `<agent> <model - thinking> <tokens ctx%>`.
- `agent-tool-view.ts` — the Agent tool's call and result rendering.
- `result-message-view.ts` — the completion message rendering.
- `fleet-view.ts` — the list below the editor and its keys.
- `viewer/conversation-viewer.ts` — the live conversation overlay.
- `agent-color.ts` — name badges.
- `mention-completion.ts` — `@` rows stacked on pi's autocomplete.
