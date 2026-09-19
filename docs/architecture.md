# Architecture — the src/ tree

**Audience:** contributors. The file map and the layering rule: what lives where, and what a
directory is allowed to import. Kept out of README, which is the user-facing reference — this
map is contributor-facing and had already rotted twice in place. For how the pieces behave see
workflows.md, rpc.md and jev.md; for why particular guards exist see decisions.md.


```
docs/                 # Long-form guides (shipped to npm; README links out to them)
  workflows.md        # SubagentWorkflow: writing, editing, saving and re-running scripts
  rpc.md              # Cross-extension integration: pi.events, subagents:rpc:*, manager registry
  decisions.md        # The issue-numbered decisions: what they are, why, and where they live
  jev.md              # The jev agent selector: what it decides, how to read it, how to tune it
examples/
  workflows/          # Runnable examples, executed by test/workflow-examples.test.ts
  agent-tool-description.md
test/                 # vitest suite; e2e/, perf/, helpers/ and fixtures/ subdirectories

src/                  # Layered by domain. A file may import only from the layers below it:
                      # `lib` < `config`, `model` < `agent` < `schedule`, `workflow` < `ui`,
                      # with `index`, `app`, `bootstrap`, `extension` and `tools` the wiring
                      # layer above them. `lib/` imports nothing from another layer, and only
                      # `index.ts` and `app.ts` may import `tools/` or `extension/`. Enforced
                      # by test/layout-fence.test.ts — a new top-level dir is structural.
  index.ts            # Extension entry: the child-session guard, one call, two re-exports.
                      # Its PATH is load-bearing — `index.ts` directly inside `src/`
                      # canonicalises to the allowlist token `src`, which agent frontmatter
                      # writes as `extensions: [src]`, `exclude_extensions: [src]` and
                      # `tools: ext:src`. Do not move it; `test/entry-manifest.test.ts`
                      # guards that.
  app.ts              # The composition root: the activation's state, every tool, command,
                      # event and renderer registration, and the wiring between domains —
                      # the file to read to see what this extension exposes.
  bootstrap.ts        # The shared handles — manager, status row, fleet list, scheduler and
                      # the collections they share — built in one ordered place and frozen

  lib/                # Shared code and types. Imports nothing from another layer.
    types.ts              # AgentConfig, AgentRecord, AgentInvocation, ViewerMarkdownMode, ...
    result.ts             # autoTag/FactoryUnion — how this extension's failure catalogs are built
    usage.ts              # Token usage shapes, accumulators, session-stats readers
    json-schema.ts        # The compiled-schema type and compiler, shared across domains
    tool-names.ts         # SUBAGENT_TOOL_NAMES / EXCLUDED_TOOL_NAMES — the pi-facing freeze list
    agent-meta.ts         # THINKING_LEVELS and the tool-list suffix the descriptions share
    fs-safe.ts            # isUnsafeName / isSymlink / safeReadFile path guards
    xml.ts                # escapeXml, shared by the notification builders
    abortable.ts          # Race a wait against Esc without cancelling the background child
    child-context.ts      # AsyncLocalStorage flag marking work done for a child session
    ui/theme.ts           # The widgets' shared UI contract (Theme, UICtx, AgentActivity, ...)
    ui/format.ts          # Pure formatters: tokens, cost, duration, turns

  config/             # Declared and persisted agent configuration
    settings.ts       # Persistent settings (~/.pi/agent/subagents.json + .pi/subagents.json)
    registry/
      agent-types.ts      # Unified agent registry (defaults + user), tool name resolution
      custom-agents.ts    # Load user-defined agents from .pi/agents/, .agents/agents/, global
      default-agents.ts   # Embedded default agent configs (general-purpose, Explore, Plan)
      agent-file-toggle.ts # Locate/edit an agent's .md: enabled: toggle, eject to frontmatter

  model/              # Which model a spawn runs on, and whether it is allowed
    model-resolver.ts # Exact provider/modelId with fuzzy fallback, as a Result
    errors.ts         # The model-resolution failure catalog (autoTag)
    enabled-models.ts # Read pi's enabledModels settings (project over global)
    model-scope.ts    # ModelScope — the scopeModels policy, shared by every spawn path

  agent/              # The subagent lifecycle
    agent-manager.ts      # Lifecycle, concurrency queue, completion notifications
    agent-runner.ts       # Session creation, execution, graceful max_turns, steer/resume
    concurrency-pools.ts  # Pools + queue + running counters — the one seam in agent-manager
    run-limits.ts         # Max-turns / grace-turns / remember-agents configuration
    description.ts        # The Agent tool's model-facing description and parameter shape
    nested-tools.ts       # Delegation tools handed to subagents (nested spawn/collect/steer)
    invocation.ts         # Shared tool-parameter schemas (isolation, join, thinking, ...)
    group-join.ts         # Batched completion notifications with timeout
    rpc.ts                # RPC handlers for cross-extension spawn/ping via pi.events
    session/
      extension-scope.ts  # Extension identity, ext: selectors, live tool-scope enforcement
      output-file.ts      # Streaming output file transcripts for agent sessions
      worktree.ts         # Git worktree isolation (create, cleanup, prune)
      status-note.ts      # Honest status note + salvaged output for non-normal outcomes
      structured-output.ts # The child's StructuredOutput tool and capture box
    prompt/
      prompts.ts          # The assembler: buildAgentPrompt + PromptExtras
      context.ts          # Parent conversation context for inherit_context
      env.ts              # Environment detection (git, platform)
      memory.ts           # Persistent agent memory (resolve, read, build prompt blocks)
      skill-loader.ts     # Preload skills (Pi-standard + Agent Skills spec layouts)
    mention/
      mention.ts          # `@handle message` grammar: suggestion triggers and send parsing
      handle-registry.ts  # What a `@handle` is called: base slug, allocation, type lookup
      mention-clone.ts    # Run a mention's turn in a cloned conversation, off the main chat

  schedule/           # Timers plus their store
    schedule.ts       # SubagentScheduler: cron / +10m / interval / ISO dispatch
    schedule-store.ts # PID-locked, session-scoped, atomic schedule persistence

  workflow/           # Scripted orchestration
    run/              # What happens while a script runs
      runtime.ts      # Worker lifecycle, RPC bridge, semaphore, caps, gate/resume
      task.ts         # local_workflow task record and batched progress updates
      progress.ts     # Progress event log and every derived view of it (pure)
      journal.ts      # Per-call journal entries, key hashing, read/append
      entry.ts        # The persisted session-entry snapshot
      host.ts         # WorkflowHost adapter over AgentManager — the one outward seam
    script/           # What runs
      meta.ts         # Extract and validate a script's pure-literal `meta` block
      saved.ts        # Resolve saved workflows by name / script path
      worker-source.ts # The sandbox: vm context, determinism prelude, script globals
    collisions.ts     # Foreign-workflow-tool policy (pure function of the tool list)
    tool-description.ts # Model-facing description carrying the orchestration patterns

  ui/                 # TUI surfaces. Only the wiring layer may import these.
    agent-status-row.ts # The status row: its text, the turn-based aging of marks, the clock
    agent-marks.ts # The row's marks: one coloured glyph per agent (pure, timer-free)
    agent-display.ts  # Agent-identity adapters: display name, prompt mode, invocation tags
    agent-result-status.ts   # The Agent tool's transcript row: result container and activity tracker
    notifications.ts  # Task-notification text, details payloads, tool-result envelopes
    agent-color.ts    # Claude Code/Agency Agents name color parsing and badge rendering
    fleet-list.ts     # FleetView: navigable agent list below the editor
    agent-mention.ts  # `@` roster (running, resumable, and startable agents) + popup rows
    schedule-menu.ts  # /agents → Scheduled jobs submenu
    select-item.ts    # Collision-safe ctx.ui.select wrapper (numbered rows)
    viewer/
      conversation-viewer.ts # Live conversation overlay for viewing agent sessions
      viewer-blocks.ts       # Tool blocks: one shape per tool, folded by default (pure)
      viewer-keys.ts         # Viewer scroll keys resolved through user keybindings
    workflow/
      workflow-card.ts   # Inline workflow card (tool result and session entry)
      workflow-dialog.ts # /agents → Workflows two-pane inspector
      workflow-menu.ts   # /agents → Workflows entry point from the FleetView
    agents/           # The /agents wizard and settings overlay
      deps.ts             # The slice of the activation context this family needs
      menu.ts             # The /agents menu root
      type-list.ts        # Agent-type list overlay
      running.ts          # Running-agents picker
      detail.ts           # Per-agent detail menu
      create-wizard.ts    # Generate / manual agent-creation wizards
      settings-overlay.ts # Settings snapshot, completeness guard and editor

  tools/              # The registered tools. Nothing but index.ts or app.ts may import these.
    deps.ts             # What the tools need: the live handles (structural slice) and the state
    usage-reporting.ts  # Wraps a tool so its result reports token usage
    agent.ts            # The Agent tool: description, renderer, execute
    workflow.ts         # The SubagentWorkflow tool plus its task plumbing
    get-subagent-result.ts # get_subagent_result
    steer-subagent.ts   # steer_subagent
    jev.ts              # The toggleable jev agent-selector tool
    jev/client.ts       # jev's HTTP client: request, parse, fail-open (injectable fetch)
    jev/state.ts        # jev roster criteria and routing-rules state

  extension/
    context.ts        # The activation's state — settings, session cells, batch grouping — plus
                      # the one handle reference it needs (the surfaces a settings write
                      # repaints). The live handles themselves are built by bootstrap.ts, not
                      # held here. Readable only by index.ts and app.ts; every other module
                      # takes a structural slice of it, which is what keeps this directory
                      # inward-facing.
```
