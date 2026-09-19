// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../lib/types.js";
import { NO_FALLBACK } from "./registry/agent-types.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  /**
   * Max concurrent FOREGROUND (blocking) agents — `0` = unlimited, the default,
   * which preserves the behaviour that has always applied: nothing bounded
   * foreground work, and pi dispatches a message's tool calls through
   * `Promise.all`, so an unqualified fan-out of blocking `Agent` calls runs all
   * at once. Set it to bound that (#253 — on local models, parallel agents
   * thrash the prompt cache).
   *
   * Deliberately independent of `maxConcurrent` rather than folded into it: a
   * foreground agent blocks the parent anyway, so charging it to the background
   * pool would let a saturated pool starve the main session of work it could
   * have done itself.
   *
   * Bounds only spawns a caller is blocking on inline. Nested children are
   * exempt — their parent is blocked awaiting them, so queueing a child behind
   * its own parent would deadlock — and so are detached spawns from
   * cross-extension RPC or `@handle` mentions, which block nobody and are
   * documented to start immediately. Foreground `resume` is also outside the
   * pool: it reuses an existing session and never reaches the spawn path, so
   * several blocking resumes in one message can still exceed the limit.
   */
  maxConcurrentForeground?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  /**
   * Whether a top-level `Agent` spawn that doesn't say runs detached.
   * Defaults to `true`, following Claude Code, where the agent backgrounds
   * unless the caller passes `run_in_background: false`. Set `false` to restore
   * the previous behaviour, where an unqualified spawn blocked the turn and
   * returned its result inline.
   *
   * Top-level only. Nested spawns (a subagent spawning its own) always default
   * to foreground regardless of this setting — see `nested-tools.ts`, where a
   * detached child would be killed by `abortOwnedChildren` when its parent
   * settles, with no notification path to deliver its result.
   *
   * An explicit `run_in_background` on the call, or in the agent file's
   * frontmatter, overrides this in both directions; the setting only decides
   * what "unspecified" means.
   */
  backgroundByDefault?: boolean;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against runtime LLM choices, not user-level config.
   * Out-of-scope handling reflects this:
   *   - Caller-supplied via `Agent({ model: "..." })` (only when frontmatter
   *     has no `model:`, since frontmatter is authoritative): hard error
   *     returned to the orchestrator, listing the allowed models. The LLM
   *     made an explicit out-of-scope choice and gets explicit feedback.
   *   - Frontmatter-pinned: warning toast + the pinned model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (neither caller nor frontmatter sets a model):
   *     warning toast + parent's model runs. The user chose the parent's
   *     model when starting the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /**
   * When true, an unreadable or unparseable agent `.md` aborts extension load
   * instead of being skipped with a warning — pi exits, naming the file.
   *
   * Startup only, by design. Mid-session reloads (one per `Agent` call) keep
   * warning: a bad edit at 3pm should not kill the session on the next
   * unrelated spawn, where the failure would look disconnected from its cause.
   * For a checked-in `.pi/agents/`, failing at startup is the point — the
   * alternative is running a *different* agent than the file names.
   * Defaults to false.
   */
  strictAgentFiles?: boolean;
  /**
   * When true, the three built-in default agents (general-purpose, Explore, Plan)
   * are not registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * Whether the Claude Code-style FleetView (the navigable main+subagents list
   * rendered below the editor) is shown. Defaults to `true`. Pure-UI: when off,
   * the list never registers and the global key handler never captures input.
   */
  fleetView?: boolean;
  /**
   * Whether `@handle message` typed at the prompt is routed to that subagent
   * instead of the main model, and whether `@` offers running agents alongside
   * pi's file completion. Defaults to `model`. Applied live.
   *
   *   - `model`: mentioning an agent that is not running asks the main model to
   *     spawn it with the `Agent` tool, Claude Code's behaviour. Costs a turn,
   *     and the model writes the agent's prompt rather than your text being it.
   *   - `direct`: that agent is started here instead, with the typed message as
   *     its prompt and no main-model turn spent.
   *   - `off`: the input hook falls straight through and the stacked
   *     autocomplete provider delegates everything back to pi's built-in one.
   *
   * Messaging a running agent and resuming a finished one are direct in both
   * `model` and `direct`. The legacy booleans are still accepted: `true` reads
   * as `model`, `false` as `off`.
   */
  agentMentions?: AgentMentionMode;
  /**
   * Whether subagents persist their pi session by default, so `@handle` can
   * reopen an agent's conversation long after its in-memory record is gone.
   * Defaults to `true`. Per-agent `persist_session:` frontmatter overrides it
   * in both directions. Turning it off restores the previous behaviour, where
   * a handle stops resolving roughly ten minutes after the agent finishes and
   * mentioning it starts a fresh run instead. Persisted sessions also appear
   * nested under the spawning session in pi's `/resume`.
   */
  rememberAgents?: boolean;
  /**
   * Display mode for the persistent above-editor agent widget:
   *   - `all`: show every agent (foreground + background).
   *   - `background`: hide foreground agents — they already render inline as the
   *     Agent tool result, so the widget would otherwise double-render them
   *     (#118); everything else (background, queued, scheduled, RPC) stays.
   *   - `off`: hide the widget entirely.
   * Defaults to `background`. Pure-UI and applied live (toggling refreshes the
   * widget).
   */
  widgetMode?: WidgetMode;
  /**
   * Project/global default for writing each subagent's `.output` transcript
   * (a JSON-lines copy of the run, stored under the OS temp dir).
   * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
   * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
   * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
   * overrides this per agent. This governs only the transcript — it does NOT
   * affect the persisted pi session (`persist_session`), worktree commits
   * (`isolation: worktree`), or memory files.
   */
  outputTranscript?: boolean;
  /**
   * Whether `isolation: "worktree"` may create a worktree at all. Defaults to
   * `true`. Set `false` on a repo where worktrees are too slow or too large to
   * be worth it (#184): a requested worktree is then dropped and the agent runs
   * in the main checkout.
   *
   * The drop is deliberately silent — there is no per-result note, because the
   * setting exists for projects whose model asks for a worktree on every call,
   * where a note would be noise on every result. What keeps the orchestrator
   * from claiming a `pi-agent-*` branch anyway is that it is never told the
   * capability exists: `isolationParam` (invocation-config.ts) drops the field
   * from both tool schemas, and `isolationGuideline` (index.ts) drops the
   * matching prose from the full and compact descriptions — a custom one opts
   * in via the `{{isolationGuideline}}` placeholder. Anything that
   * reintroduces the prose has to reintroduce a note with it.
   *
   * Deliberately a downgrade rather than an error. The fail-loud rule covers
   * worktrees that *cannot* be created; this is the user declining one, and
   * throwing would reject exactly the calls that the `isolation: "off"` value
   * exists to tolerate. Enforced below the tool boundary, so it also covers the
   * scheduler and the unvalidated cross-extension RPC path.
   */
  worktreeIsolation?: boolean;
  /**
   * Master switch for scripted workflows. Defaults to `true`.
   *
   * Off is not a soft hide: the `SubagentWorkflow` tool is never registered, so
   * the model is not told it exists and cannot call it, the `/agents`
   * Workflows entry is hidden, and `--subagents-workflow-file` is refused.
   *
   * Absent is not the same as `true`. Unset means *auto*: on, but yielding to
   * another extension that already offers a workflow tool, because two
   * orchestrators in one tool spec is a worse default than none — the model
   * has to guess which to call, and pays for both descriptions to find out.
   * Setting it explicitly pins the answer in both directions: `true` keeps
   * ours whatever else is loaded, `false` is off regardless. See
   * `resolveWorkflowCollisions` in index.ts.
   *
   * Read once at extension init, before registration, so flipping it in
   * `/agents → Settings` takes effect on the next pi session — the same
   * contract `schedulingEnabled` has, and for the same reason: a tool spec is
   * fixed once pi has it.
   */
  workflowsEnabled?: boolean;
  /**
   * Master switch for the `jev` agent-selector tool. Defaults to `false` —
   * the tool costs an API call every time it is used, so it is opt-in. When
   * `true`, the `jev` tool is registered for the orchestrator session on the
   * next pi load (registration happens at extension init).
   */
  jevEnabled?: boolean;
  /**
   * Hard ceiling on nested subagent delegation, counted from the main session:
   * main = 0, its subagents = 1, their children = 2. Defaults to `2`; `0` or `1`
   * disables nesting project-wide. Read when a subagent session is built, so a
   * change applies to agents started after it.
   */
  maxSubagentDepth?: number;
  /**
   * Agent type substituted when a caller-supplied `subagent_type` doesn't
   * resolve to exactly one enabled agent (unknown, disabled, or ambiguous by
   * case). Omitted keeps the historical `general-purpose` fallback; a type name
   * routes those calls to that agent instead; `"none"` disables the fallback so
   * dispatch fails closed with an error naming the available types.
   *
   * The boolean `false` is accepted as a spelling of `"none"`, because a boolean
   * would otherwise be dropped as the wrong type and silently leave the
   * PERMISSIVE default in place while the author believes strict dispatch is on
   * — the wrong direction to fail for this setting. Every other value is an
   * agent name, so a mistaken `"off"` fails loudly at dispatch rather than
   * meaning one thing here and another in the resolver.
   */
  fallbackSubagent?: string;
  /**
   * Whether this extension's tool results carry a `usage` field, so subagent
   * spend reaches the parent session's own accounting. Defaults to `false`.
   *
   * Subagents run in their own pi sessions, so by default the parent's footer,
   * statusline and `/cost` show only what the main model spent — a session that
   * delegated most of its work reads as nearly free. Pi folds
   * `toolResult.usage` into `getSessionStats()`, so attaching it makes those
   * surfaces count subagents too, under `/cost`'s "Tools/summaries" bucket.
   *
   * Off by default because it changes numbers the user may already be tracking
   * (a statusline reading session cost will step up), not because the numbers
   * are wrong.
   *
   * Three properties of what gets reported:
   *   - Tokens exclude `cacheRead`, for the reason in `usage.ts` — the parent's
   *     token total therefore rises by billed tokens only.
   *   - Cost is pi's own per-message `usage.cost.total`; we price nothing, and
   *     a model pi has no rates for contributes 0.
   *   - The context-window percentage is untouched. Pi derives it from assistant
   *     messages alone (`getContextUsage`), so a delegating session's context
   *     does not appear to fill up faster.
   */
  reportUsage?: boolean;
  /**
   * Whether the subagent surfaces show an estimated dollar cost next to their
   * token counts (widget, FleetView, conversation viewer, foreground results,
   * completion notifications). Defaults to `false`. Applied live.
   *
   * Rendered as `~$0.0042` — the tilde marks it as pi's reported estimate
   * rather than a billed figure, and it is omitted entirely when the model has
   * no pricing data, so a local model shows tokens and no dollars.
   *
   * Independent of `reportUsage`: this one is what a human reads, that one is
   * what the parent session counts.
   */
  showCost?: boolean;

  /**
   * Whether the widget's running rows name the model driving each agent and the
   * thinking level it is running at.
   *
   * Off by default, unlike the tool result and the conversation viewer, which
   * show the pair unconditionally: those have a line to themselves, while the
   * widget row already carries the description, turns, tool uses, tokens and
   * elapsed time, and every character it gains is one the description loses on a
   * narrow terminal.
   */
  showModel?: boolean;
  /**
   * How much of the conversation viewer's transcript renders as Markdown.
   * Defaults to `assistant`. Applied live — the viewer's `m` key cycles this
   * same setting, so a choice made in the overlay persists like one made in
   * `/agents → Settings`.
   *
   * Scoped rather than all-or-nothing because the two kinds of content have
   * different contracts: assistant text is authored as Markdown, while a tool
   * result is whatever bytes the tool produced. Rendering the latter as
   * Markdown is lossy in ways that look like the tool misbehaved — see
   * `ViewerMarkdownMode` for the specific rewrites.
   */
  viewerMarkdown?: ViewerMarkdownMode;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/**
 * The activation state a setting lands in. Declared structurally rather than imported —
 * `config/` may not import `extension/` — and every member is one `ActivationContext` has;
 * the {@link FIELDS} table below is what keeps the two in step, since each entry's `apply`
 * names the member it writes.
 */
export interface SettingsSurface {
  /** The two concurrency pools: the only manager state a setting drives. */
  manager: { setMaxConcurrent(n: number): void; setMaxConcurrentForeground(n: number): void };
  /** The `scopeModels` policy. */
  modelScope: { setEnabled(enabled: boolean): void };

  strictAgentFiles: boolean;
  defaultJoinMode: JoinMode;
  backgroundByDefault: boolean;
  schedulingEnabled: boolean;
  toolDescriptionMode: ToolDescriptionMode;
  fleetViewEnabled: boolean;
  agentMentionMode: AgentMentionMode;
  widgetMode: WidgetMode;
  reportUsage: boolean;
  showCost: boolean;
  showModel: boolean;
  viewerMarkdown: ViewerMarkdownMode;
  workflowsEnabled: boolean;
  jevEnabled: boolean;

  // The setters whose assignment does more than store the value: a repaint, the usage
  // drain, or latching the user's own answer.
  setReportUsage(b: boolean): void;
  setShowCost(b: boolean): void;
  setShowModel(b: boolean): void;
  setWidgetMode(m: WidgetMode): void;
  setFleetViewEnabled(b: boolean): void;
  setWorkflowsEnabled(b: boolean): void;
}

/**
 * Where a sanitized setting lands: the activation surface above, plus the settings owned by
 * modules that read them directly rather than through the context. Those arrive as plain
 * callbacks because they are module-level state — the runner's turn budgets, the registry's
 * depth and fallback flags, the transcript and worktree switches.
 */
export interface SettingsTarget {
  context: SettingsSurface;
  setDefaultMaxTurns(n: number): void;
  setGraceTurns(n: number): void;
  setMaxSubagentDepth(n: number): void;
  setFallbackSubagent(v: string | undefined): void;
  setDisableDefaultAgents(b: boolean): void;
  setRememberAgents(b: boolean): void;
  setOutputTranscript(b: boolean): void;
  setWorktreeIsolation(b: boolean): void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>(["all", "background", "off"]);
const VALID_VIEWER_MARKDOWN_MODES: ReadonlySet<string> = new Set<ViewerMarkdownMode>(["off", "assistant", "all"]);
const VALID_AGENT_MENTION_MODES: ReadonlySet<string> = new Set<AgentMentionMode>(["model", "direct", "off"]);

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;

/** Both halves of one persisted setting: how it is sanitized, and where the value lands. */
interface SettingsField {
  /** Accept the raw JSON value, or return `undefined` to drop the field. */
  parse: (raw: unknown) => unknown;
  /** Apply this field's own sanitized value — read off `s`, so the two halves stay typed. */
  apply: (target: SettingsTarget, s: SubagentsSettings) => void;
}

/** Run `apply` only when the setting is present: absence keeps the runtime default. */
function when<T>(value: T | undefined, apply: (value: T) => void): void {
  if (value !== undefined) apply(value);
}

/** Accept a boolean, or `undefined` to drop the field. */
function bool(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

/** Accept an integer inside `[min, max]`, or `undefined` to drop the field. */
function intInRange(min: number, max: number): (raw: unknown) => number | undefined {
  return (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : undefined);
}

/** Accept one of a known set of spellings, or `undefined` to drop the field. */
function oneOf<T extends string>(valid: ReadonlySet<string>): (raw: unknown) => T | undefined {
  return (raw) => (typeof raw === "string" && valid.has(raw) ? (raw as T) : undefined);
}

/**
 * `fallbackSubagent`'s one non-string spelling: a boolean would otherwise be dropped,
 * silently leaving the PERMISSIVE default in place. Every string is an agent name except the
 * `none` sentinel, which the resolver recognizes — so a mistaken "off" fails loudly at
 * dispatch instead of meaning something different here than it does there.
 */
function parseFallbackSubagent(raw: unknown): string | undefined {
  if (raw === false) return NO_FALLBACK;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * Every persisted setting, once: how it is sanitized out of raw JSON, and where the sanitized
 * value lands. The shape check, the applier interface and the `typeof` re-checks it used to
 * take are all this table; the `Record` type makes a field with no writer a compile error.
 */
const FIELDS: Record<keyof SubagentsSettings, SettingsField> = {
  maxConcurrent: {
    parse: intInRange(1, MAX_CONCURRENT_CEILING),
    apply: (t, s) => when(s.maxConcurrent, (v) => t.context.manager.setMaxConcurrent(v)),
  },
  // Floor 0, not 1 like maxConcurrent above: 0 is the documented "unlimited" value and the
  // default, so dropping it would silently be unrepresentable.
  maxConcurrentForeground: {
    parse: intInRange(0, MAX_CONCURRENT_CEILING),
    apply: (t, s) => when(s.maxConcurrentForeground, (v) => t.context.manager.setMaxConcurrentForeground(v)),
  },
  defaultMaxTurns: {
    parse: intInRange(0, MAX_TURNS_CEILING),
    apply: (t, s) => when(s.defaultMaxTurns, (v) => t.setDefaultMaxTurns(v)),
  },
  graceTurns: {
    parse: intInRange(1, GRACE_TURNS_CEILING),
    apply: (t, s) => when(s.graceTurns, (v) => t.setGraceTurns(v)),
  },
  maxSubagentDepth: {
    parse: intInRange(0, SUBAGENT_DEPTH_CEILING),
    apply: (t, s) => when(s.maxSubagentDepth, (v) => t.setMaxSubagentDepth(v)),
  },
  fallbackSubagent: {
    parse: parseFallbackSubagent,
    apply: (t, s) => when(s.fallbackSubagent, (v) => t.setFallbackSubagent(v)),
  },
  defaultJoinMode: {
    parse: oneOf<JoinMode>(VALID_JOIN_MODES),
    apply: (t, s) =>
      when(s.defaultJoinMode, (v) => {
        t.context.defaultJoinMode = v;
      }),
  },
  backgroundByDefault: {
    parse: bool,
    apply: (t, s) =>
      when(s.backgroundByDefault, (v) => {
        t.context.backgroundByDefault = v;
      }),
  },
  schedulingEnabled: {
    parse: bool,
    apply: (t, s) =>
      when(s.schedulingEnabled, (v) => {
        t.context.schedulingEnabled = v;
      }),
  },
  scopeModels: {
    parse: bool,
    apply: (t, s) =>
      when(s.scopeModels, (v) => {
        t.context.modelScope.setEnabled(v);
      }),
  },
  strictAgentFiles: {
    parse: bool,
    apply: (t, s) =>
      when(s.strictAgentFiles, (v) => {
        t.context.strictAgentFiles = v;
      }),
  },
  disableDefaultAgents: {
    parse: bool,
    apply: (t, s) => when(s.disableDefaultAgents, (v) => t.setDisableDefaultAgents(v)),
  },
  toolDescriptionMode: {
    parse: oneOf<ToolDescriptionMode>(VALID_TOOL_DESCRIPTION_MODES),
    apply: (t, s) =>
      when(s.toolDescriptionMode, (v) => {
        t.context.toolDescriptionMode = v;
      }),
  },
  fleetView: {
    parse: bool,
    apply: (t, s) =>
      when(s.fleetView, (v) => {
        t.context.setFleetViewEnabled(v);
      }),
  },
  // Was a boolean before the `model` mode existed. A hand-written or previously-written
  // `true` means "on", which is now the default `model`.
  agentMentions: {
    parse: (raw) =>
      typeof raw === "boolean" ? (raw ? "model" : "off") : oneOf<AgentMentionMode>(VALID_AGENT_MENTION_MODES)(raw),
    apply: (t, s) =>
      when(s.agentMentions, (v) => {
        t.context.agentMentionMode = v;
      }),
  },
  rememberAgents: {
    parse: bool,
    apply: (t, s) => when(s.rememberAgents, (v) => t.setRememberAgents(v)),
  },
  widgetMode: {
    parse: oneOf<WidgetMode>(VALID_WIDGET_MODES),
    apply: (t, s) =>
      when(s.widgetMode, (v) => {
        t.context.setWidgetMode(v);
      }),
  },
  outputTranscript: {
    parse: bool,
    apply: (t, s) => when(s.outputTranscript, (v) => t.setOutputTranscript(v)),
  },
  worktreeIsolation: {
    parse: bool,
    apply: (t, s) => when(s.worktreeIsolation, (v) => t.setWorktreeIsolation(v)),
  },
  reportUsage: {
    parse: bool,
    apply: (t, s) =>
      when(s.reportUsage, (v) => {
        t.context.setReportUsage(v);
      }),
  },
  showCost: {
    parse: bool,
    apply: (t, s) =>
      when(s.showCost, (v) => {
        t.context.setShowCost(v);
      }),
  },
  showModel: {
    parse: bool,
    apply: (t, s) =>
      when(s.showModel, (v) => {
        t.context.setShowModel(v);
      }),
  },
  viewerMarkdown: {
    parse: oneOf<ViewerMarkdownMode>(VALID_VIEWER_MARKDOWN_MODES),
    apply: (t, s) =>
      when(s.viewerMarkdown, (v) => {
        t.context.viewerMarkdown = v;
      }),
  },
  workflowsEnabled: {
    parse: bool,
    apply: (t, s) =>
      when(s.workflowsEnabled, (v) => {
        t.context.setWorkflowsEnabled(v);
      }),
  },
  jevEnabled: {
    parse: bool,
    apply: (t, s) =>
      when(s.jevEnabled, (v) => {
        t.context.jevEnabled = v;
      }),
  },
};

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  for (const key of Object.keys(FIELDS) as (keyof SubagentsSettings)[]) {
    const value = FIELDS[key].parse(r[key]);
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state the {@link FIELDS} table names. */
export function applySettings(s: SubagentsSettings, target: SettingsTarget): void {
  for (const key of Object.keys(FIELDS) as (keyof SubagentsSettings)[]) {
    FIELDS[key].apply(target, s);
  }
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  target: SettingsTarget,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, target);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
