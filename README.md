# @tintinweb/pi-subagents

A [pi](https://pi.dev) extension that brings **Claude Code-style subagents** to pi's TUI: delegate a task to an agent defined in a Markdown file, run it in the background (the default) or wait for it, steer it mid-run, read its result, resume it — or **fork** the current conversation into a worker that continues from everything said so far.

<img width="600" alt="pi-subagents screenshot" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />

## Features

- **Three tools, Claude Code's names** — `Agent`, `get_subagent_result`, `steer_subagent`.
- **Agents are files** — `<name>.md` with nine frontmatter fields; the body is the agent's persona.
- **A subagent prompt like your own** — pi's own system prompt (tool list, tool rules, docs), the persona, then your global and project `AGENTS.md`.
- **Fork** — `subagent_type: "fork"` branches the main conversation into a worker with one directive; it reuses the parent's prompt cache.
- **Background by default** — a pool with a queue (`maxConcurrent`, default 10); parallel agents from one turn report back as one message.
- **FleetView and a live viewer** — every running agent listed under the editor; open one to watch and steer it.
- **`@mention`** — `@finder look at the RPC path` asks the main model to delegate to that agent.

## Install

```bash
pi install npm:@tintinweb/pi-subagents
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

Requires pi **1.1.0 or newer** (the structured system prompt and transcript tool declarations it builds on); the `peerDependencies` range declares it.

## Agent files

Agents are discovered from `~/.pi/agent/agents/*.md` (global) and `<project>/.pi/agents/*.md` (project wins a name clash). There are no built-in agents.

```markdown
---
name: finder
description: Search the codebase and report where things are
model: zai-coding-cn/glm-5.3-flash
thinking: low
tools: read, ext:jun_code
max_turns: 40
color: "#FEFD99"
---
You are a finder. Search, read, and report file:line evidence. Never edit.
```

| Field | Default | Meaning |
|---|---|---|
| `name` | file name | The `subagent_type` that selects this agent. |
| `description` | the name | Shown to the main model and in `/agents`. |
| `model` | parent's model | Exact `provider/modelId`; an unknown model fails the spawn (no fuzzy match, no fallback). |
| `thinking` | pi default | Thinking level. |
| `tools` | every tool | Built-in names plus `ext:<extension>` (all of its tools) and `ext:<extension>/<tool>`. `Agent`, `get_subagent_result` and `steer_subagent` never reach a subagent. |
| `skills` | `true` | `false` keeps pi's skills index out of the agent's prompt. |
| `max_turns` | unlimited | At the cap the agent is told to wrap up; after `max(10, ceil(max_turns × 0.25))` more turns it is stopped and its partial answer returned. |
| `color` | none | Name badge: `"#RRGGBB"` or one of red, blue, green, yellow, purple, orange, pink, cyan. |
| `enabled` | `true` | `false` hides the agent (a project file can hide a global one). |

### The subagent's system prompt

The same layout as a `pil` session: pi's preamble, `<tools>`, `<rules>` (every tool's guidelines), `<docs>`, then `<addendum>` holding `<active_agent name="…"/>` and the agent file's body, then `<project_context>` with your global and project `AGENTS.md`, then `<cwd>`. The main agent's `prompt` is the first user message.

## Tools

### `Agent`

| Parameter | Required | Meaning |
|---|---|---|
| `prompt` | yes | The task. |
| `description` | yes | 3–5 words, shown in the UI. |
| `subagent_type` | yes | An agent file's `name`, or `"fork"`. An unknown or disabled type is an error. |
| `run_in_background` | no | Default `true`: returns at once and the result arrives as a message. `false` waits and returns the answer. |
| `model` | no | Exact `provider/modelId`, used when the agent file sets none. |
| `thinking` | no | Used when the agent file sets none. |
| `name` | no | A handle to address the agent by (`auth-audit`); default is its type, numbered on collision (`scout`, `scout-2`). |
| `resume` | no | An agent id or handle to continue with `prompt`. |

### `get_subagent_result`

| Parameter | Meaning |
|---|---|
| `agent_id` | Id or handle. |
| `wait` | Block until the agent finishes. |
| `verbose` | Append the agent's conversation, tool calls included. |

Reading a finished result marks it read: its completion message is not sent.

### `steer_subagent`

| Parameter | Meaning |
|---|---|
| `agent_id` | Id or handle. |
| `message` | Delivered as a user message after the agent's current tool call; a queued agent gets it with its prompt. |

## Fork

`Agent({ subagent_type: "fork", prompt, description })` starts a worker that continues the main conversation: its session is the main session's active branch, the in-flight assistant message (with one `Fork started — processing in background` result per tool call), then the prompt wrapped as a one-shot directive. It runs on the main session's model, thinking level, tools and prompt, so the provider's prompt cache is reused; calling `Agent` inside a fork is refused. A fork needs a saved main session (not `--no-session`) and can be resumed like any agent.

## Background agents

- **Pool** — at most `maxConcurrent` background agents run at once (default 10); the rest wait as queued and start in order. Foreground calls are not pooled.
- **Smart join** — two or more background agents started in the same turn report back as one message, or a partial one 30s after the first finishes (stragglers follow in 15s windows). A lone agent reports on its own.
- **Sessions** — a subagent's session is saved beside the main session's (header `parentSession`) whenever the main session is saved.

## TUI

- **Agent row** — every surface names an agent as `<agent>  <model - thinking>  <tokens ctx%>`; there is no cost display.
- **FleetView** — running agents (and ones that just finished) under the editor: status, clock, name, description, model and context use. At an empty prompt `↓` or `←` focuses it, `↑`/`↓` select, `Enter` opens the agent, `Esc` returns.
- **Viewer** — a live, auto-updating overlay of one agent's conversation. `↑`/`↓` scroll, `Enter` steers, `x` stops the agent, `Esc` closes. It stays open after the agent finishes.
- **`@mention`** — `@<agent> message` sends your message to the main model with a reminder to delegate to that agent (or to steer/resume an agent that already has that handle); `@main` strips the prefix. Typing `@` suggests agents alongside files.
- **`/agents`** — Running agents (opens the viewer) and Agent types (read-only detail).

## Settings

One setting, read from `~/.pi/eyu/subagents.json` and `<project>/.pi/subagents.json` (project wins):

```json
{ "maxConcurrent": 10 }
```

Every other key in those files is ignored.

## Architecture

See [docs/architecture.md](docs/architecture.md).

## License

MIT
