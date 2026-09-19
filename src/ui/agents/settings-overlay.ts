/**
 * settings-overlay.ts — `/agents → Settings`: the snapshot, its completeness guard, and the
 * overlay that drives every setter.
 *
 * `snapshotSettings` is the read half of the settings system: every mutation writes the whole
 * object back to disk, so a key missing there is erased from the user's `subagents.json` on the
 * next unrelated toggle. `_NoMissingSettingsKeys` is the compile-time guard that keeps that from
 * happening quietly. Nothing here owns state — every write goes through the activation context.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../../agent/nested-tools.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "../../agent/run-limits.js";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "../../agent/session/output-file.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../../agent/session/worktree.js";
import { getAvailableTypes, getFallbackSubagent, isDefaultsDisabled, NO_FALLBACK, setFallbackSubagent } from "../../config/registry/agent-types.js";
import { type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "../../config/settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../../lib/types.js";
import type { AgentsUiDeps } from "./deps.js";

/**
 * Every settings mutation writes this WHOLE object back to disk, so a field
 * missing here is erased from the user's subagents.json the next time they
 * toggle something unrelated. `SubagentsSettings` has every field optional,
 * so a `: SubagentsSettings` return annotation would let a newly-added setting
 * be forgotten here and still type-check. `satisfies` instead: it still checks
 * each value's type and rejects a mistyped key, but leaves the return type
 * inferred so `_NoMissingSettingsKeys` below can check completeness.
 */
/** The whole settings snapshot, as one object — exported so every other entry point persists the same shape. */
export function snapshotSettings(deps: AgentsUiDeps) {
  return {
    maxConcurrent: deps.services.manager.getMaxConcurrent(),
    // 0 = unlimited, and the default — see SubagentsSettings.
    maxConcurrentForeground: deps.services.manager.getMaxConcurrentForeground(),
    // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
    // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
    defaultMaxTurns: getDefaultMaxTurns() ?? 0,
    graceTurns: getGraceTurns(),
    defaultJoinMode: deps.context.defaultJoinMode,
    backgroundByDefault: deps.context.backgroundByDefault,
    schedulingEnabled: deps.context.schedulingEnabled,
    scopeModels: deps.services.modelScope.isEnabled(),
    strictAgentFiles: deps.context.strictAgentFiles,
    disableDefaultAgents: isDefaultsDisabled(),
    toolDescriptionMode: deps.context.toolDescriptionMode,
    fleetView: deps.context.fleetViewEnabled,
    agentMentions: deps.context.agentMentionMode,
    rememberAgents: getRememberAgents(),
    widgetMode: deps.context.widgetMode,
    outputTranscript: getOutputTranscriptDefault(),
    worktreeIsolation: isWorktreeIsolationEnabled(),
    // The user's answer, not the effective one. A stand-down for another
    // extension's workflow tool is scoped to the session it was detected in;
    // writing it here would let an unrelated settings change three menus away
    // freeze it into the file as an explicit `false`, which then survives
    // uninstalling the extension it was deferring to. undefined is dropped by
    // JSON.stringify, so unset stays unset — same reasoning as
    // `fallbackSubagent` below.
    workflowsEnabled: deps.context.workflowsPinned ? deps.context.workflowsEnabled : undefined,
    jevEnabled: deps.context.jevEnabled,
    maxSubagentDepth: getMaxSubagentDepth(),
    // Deliberately NOT `?? "general-purpose"`: every settings change writes the
    // whole snapshot, and materializing the implicit default would turn it into
    // explicit configuration — which then fails loudly if general-purpose later
    // goes away. undefined is dropped by JSON.stringify.
    fallbackSubagent: getFallbackSubagent(),
    reportUsage: deps.context.reportUsage,
    showCost: deps.context.showCost,
    showModel: deps.context.showModel,
    viewerMarkdown: deps.context.viewerMarkdown,
  } satisfies SubagentsSettings;
}

// Compile-time completeness guard for snapshotSettings(). If a field is added
// to SubagentsSettings and not mirrored above, this Exclude is non-empty and
// fails to satisfy `never` — turning a silent settings-erasure bug into a
// typecheck error. `npm run typecheck` runs in CI.
type _NoMissingSettingsKeys =
  Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
    ? true
    : ["snapshotSettings() is missing a SubagentsSettings key"];
const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
void _settingsSnapshotIsComplete;

const NUMERIC_IDS = new Set([
  "maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "maxSubagentDepth",
]);

export async function showSettings(ctx: ExtensionCommandContext, deps: AgentsUiDeps): Promise<void> {
  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(deps),
      successMsg,
      (event, payload) => deps.pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  function buildItems(): SettingItem[] {
    const mc = deps.services.manager.getMaxConcurrent();
    const mcf = deps.services.manager.getMaxConcurrentForeground();
    const dmt = getDefaultMaxTurns() ?? 0;
    const gt = getGraceTurns();
    const msd = getMaxSubagentDepth();
    // Label what unset actually does — it targets general-purpose even when
    // that is unregistered (the permissive hardcoded tier), so showing "none"
    // there would advertise strict dispatch for the most permissive state.
    // `values` still offers only resolvable targets, so the user cannot
    // persist a fallback that would hard-error on every dispatch.
    const fallbackValue = getFallbackSubagent() ?? "general-purpose";
    const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

    return [
      {
        id: "maxConcurrent",
        label: "Max concurrency",
        description: "Max concurrent background agents (Enter to type)",
        currentValue: String(mc),
        values: [String(mc)],
      },
      {
        id: "maxConcurrentForeground",
        label: "Max foreground concurrency",
        description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
        currentValue: String(mcf),
        values: [String(mcf)],
      },
      {
        id: "defaultMaxTurns",
        label: "Default max turns",
        description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
        currentValue: String(dmt),
        values: [String(dmt)],
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        description: "Grace turns after wrap-up steer (Enter to type)",
        currentValue: String(gt),
        values: [String(gt)],
      },
      {
        id: "maxSubagentDepth",
        label: "Nested depth",
        description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
        currentValue: String(msd),
        values: [String(msd)],
      },
      {
        id: "joinMode",
        label: "Join mode",
        description: "Default join mode for background agents",
        currentValue: deps.context.defaultJoinMode,
        values: ["smart", "async", "group"],
      },
      {
        id: "backgroundByDefault",
        label: "Background by default",
        description: "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
        currentValue: deps.context.backgroundByDefault ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "schedulingEnabled",
        label: "Scheduling",
        description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
        currentValue: deps.context.schedulingEnabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "jevEnabled",
        label: "Jev agent selector",
        description: "Jev decision tool (off = `jev` tool absent from the session on next pi session)",
        currentValue: deps.context.jevEnabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "workflowsEnabled",
        label: "Workflows",
        description:
          "Scripted workflows, on unless another extension provides a workflow tool "
          + "(off keeps the SubagentWorkflow tool out of the tool spec; applies on next pi session)",
        currentValue: deps.context.workflowsEnabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "scopeModels",
        label: "Scope models",
        description: "Validate subagent models against scoped models (/scoped-models)",
        currentValue: deps.services.modelScope.isEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "strictAgentFiles",
        label: "Strict agent files",
        description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
        currentValue: deps.context.strictAgentFiles ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "disableDefaultAgents",
        label: "Disable defaults",
        description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
        currentValue: isDefaultsDisabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "fallbackSubagent",
        label: "Fallback agent",
        description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
        currentValue: fallbackValue,
        values: fallbackValues,
      },
      {
        id: "outputTranscript",
        label: "Output transcript",
        description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
        currentValue: getOutputTranscriptDefault() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "worktreeIsolation",
        label: "Worktree isolation",
        description:
          "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
        currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "reportUsage",
        label: "Report usage to session",
        description:
          "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
        currentValue: deps.context.reportUsage ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showCost",
        label: "Show cost",
        description:
          "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
        currentValue: deps.context.showCost ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showModel",
        label: "Show model",
        description:
          "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The Agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
        currentValue: deps.context.showModel ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "viewerMarkdown",
        label: "Viewer markdown",
        description:
          "How much of the conversation viewer renders as Markdown. assistant = assistant text only (default); all = tool results too, for tools that emit Markdown — accepting that a Markdown pass over a diff or a log eats `#` comments, swallows a `---` line and re-fences indented output; off = everything verbatim. `m` in the viewer cycles the same setting (footer: raw / md / md+).",
        currentValue: deps.context.viewerMarkdown,
        values: ["off", "assistant", "all"],
      },
      {
        id: "fleetView",
        label: "Fleet view",
        description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
        currentValue: deps.context.fleetViewEnabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "agentMentions",
        label: "Agent mentions",
        description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
        currentValue: deps.context.agentMentionMode,
        values: ["model", "direct", "off"],
      },
      {
        id: "rememberAgents",
        label: "Remember agents",
        description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
        currentValue: getRememberAgents() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "widgetMode",
        label: "Widget (legacy)",
        description: "The above-editor widget is gone — the Agent view below the editor is the only agent list. Kept so an older subagents.json keeps its value; no surface reads the mode any more.",
        currentValue: deps.context.widgetMode,
        values: ["all", "background", "off"],
      },
      {
        id: "toolDescriptionMode",
        label: "Tool description",
        description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
        currentValue: deps.context.toolDescriptionMode,
        values: ["full", "compact", "custom"],
      },
    ];
  }

  function applyValue(id: string, value: string) {
    if (id === "maxConcurrent") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        deps.services.manager.setMaxConcurrent(n);
        notifyApplied(ctx, `Max concurrency set to ${n}`);
      }
    } else if (id === "maxConcurrentForeground") {
      // 0 is meaningful here, unlike maxConcurrent above: it means unlimited.
      const n = parseInt(value, 10);
      if (n >= 0) {
        deps.services.manager.setMaxConcurrentForeground(n);
        notifyApplied(ctx, n === 0
          ? "Max foreground concurrency set to unlimited"
          : `Max foreground concurrency set to ${n}`);
      }
    } else if (id === "defaultMaxTurns") {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        notifyApplied(ctx, "Default max turns set to unlimited");
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        notifyApplied(ctx, `Default max turns set to ${n}`);
      }
    } else if (id === "graceTurns") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        notifyApplied(ctx, `Grace turns set to ${n}`);
      }
    } else if (id === "maxSubagentDepth") {
      const n = parseInt(value, 10);
      if (n >= 0) {
        setMaxSubagentDepth(n);
        notifyApplied(
          ctx,
          n <= 1
            ? "Nested delegation disabled"
            : `Nested depth set to ${n}. Applies to agents started from now on.`,
        );
      }
    } else if (id === "joinMode") {
      deps.context.defaultJoinMode = value as JoinMode;
      notifyApplied(ctx, `Default join mode set to ${value}`);
    } else if (id === "backgroundByDefault") {
      const enabled = value === "on";
      deps.context.backgroundByDefault = enabled;
      notifyApplied(
        ctx,
        enabled
          ? "Agent calls run in the background unless they pass run_in_background: false"
          : "Agent calls block and return inline unless they pass run_in_background: true",
      );
    } else if (id === "schedulingEnabled") {
      const enabled = value === "on";
      if (enabled === deps.context.schedulingEnabled) {
        ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
      } else {
        deps.context.schedulingEnabled = enabled;
        if (!enabled) deps.services.scheduler.stop();  // immediate kill — outstanding fires stop ticking
        notifyApplied(
          ctx,
          `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
        );
      }
    } else if (id === "workflowsEnabled") {
      const enabled = value === "on";
      if (enabled === deps.context.workflowsEnabled) {
        ctx.ui.notify(`Workflows already ${enabled ? "enabled" : "disabled"}.`, "info");
      } else {
        deps.context.setWorkflowsEnabled(enabled);
        // Runs already in flight keep going: the switch governs whether the
        // tool is offered, and killing live agents on a settings toggle would
        // lose work the user never asked to discard.
        notifyApplied(
          ctx,
          `Workflows ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
        );
      }
    } else if (id === "jevEnabled") {
      const enabled = value === "on";
      if (enabled === deps.context.jevEnabled) {
        ctx.ui.notify(`Jev already ${enabled ? "enabled" : "disabled"}.`, "info");
      } else {
        deps.context.jevEnabled = enabled;
        notifyApplied(
          ctx,
          `Jev agent selector ${enabled ? "enabled" : "disabled"}. Tool appears on next pi session.`,
        );
      }
    } else if (id === "scopeModels") {
      const enabled = value === "on";
      deps.services.modelScope.setEnabled(enabled);
      notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "strictAgentFiles") {
      const enabled = value === "on";
      deps.context.strictAgentFiles = enabled;
      notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
    } else if (id === "disableDefaultAgents") {
      const enabled = value === "on";
      deps.setDisableDefaultAgents(enabled);
      notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
    } else if (id === "fallbackSubagent") {
      setFallbackSubagent(value);
      notifyApplied(
        ctx,
        value === NO_FALLBACK
          ? "Unknown or disabled agent types will now be rejected"
          : `Unknown agent types will fall back to ${value}`,
      );
    } else if (id === "outputTranscript") {
      const enabled = value === "on";
      setOutputTranscriptDefault(enabled);
      notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
    } else if (id === "worktreeIsolation") {
      const enabled = value === "on";
      setWorktreeIsolationEnabled(enabled);
      // The refusal is live, but the tool schema is built at registration, so
      // the isolation parameter only appears/disappears next session.
      notifyApplied(
        ctx,
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
      );
    } else if (id === "toolDescriptionMode") {
      deps.context.toolDescriptionMode = value as ToolDescriptionMode;
      notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
    } else if (id === "reportUsage") {
      const enabled = value === "on";
      deps.context.setReportUsage(enabled);
      notifyApplied(
        ctx,
        enabled
          ? "Subagent usage now counted in this session's totals"
          : "Subagent usage no longer counted in this session's totals",
      );
    } else if (id === "showCost") {
      const enabled = value === "on";
      deps.context.setShowCost(enabled);
      notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "showModel") {
      const enabled = value === "on";
      deps.context.setShowModel(enabled);
      notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "viewerMarkdown") {
      deps.context.viewerMarkdown = value as ViewerMarkdownMode;
      notifyApplied(ctx, `Viewer markdown set to ${value}`);
    } else if (id === "fleetView") {
      const enabled = value === "on";
      deps.context.setFleetViewEnabled(enabled);
      notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "agentMentions") {
      const mode = value as AgentMentionMode;
      deps.context.agentMentionMode = mode;
      notifyApplied(
        ctx,
        mode === "off"
          ? "Agent mentions disabled"
          : mode === "model"
            ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
            : "Agent mentions on — a mentioned agent starts here, with no model call",
      );
    } else if (id === "rememberAgents") {
      const enabled = value === "on";
      setRememberAgents(enabled);
      notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "widgetMode") {
      deps.context.setWidgetMode(value as WidgetMode);
      notifyApplied(ctx, `Widget set to ${value}`);
    }
  }

  let list: SettingsList;
  // Track current selection index directly (SettingsList doesn't expose it).
  // Updated on arrow keys so Enter knows which field is selected immediately.
  let currentIndex = 0;

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const items = buildItems();

    list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        applyValue(id, newValue);
      },
      () => done(undefined as undefined),
    );

    const container = new Container();
    container.addChild(new Text("⚙  Subagent Settings", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Track navigation so Enter knows the current field
        if (matchesKey(data, "up")) {
          currentIndex = Math.max(0, currentIndex - 1);
        } else if (matchesKey(data, "down")) {
          currentIndex = Math.min(items.length - 1, currentIndex + 1);
        }

        // Enter on numeric field → close and prompt for typed input
        if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
          done(items[currentIndex].id);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  // If a numeric field ID was returned, prompt for typed input
  if (result && NUMERIC_IDS.has(result)) {
    const current = result === "maxConcurrent"
      ? String(deps.services.manager.getMaxConcurrent())
      : result === "maxConcurrentForeground"
        ? String(deps.services.manager.getMaxConcurrentForeground())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : result === "maxSubagentDepth"
            ? String(getMaxSubagentDepth())
            : String(getGraceTurns());

    const label = result === "maxConcurrent"
      ? "Max concurrency (1+)"
      : result === "maxConcurrentForeground"
        ? "Max foreground concurrency (0 = unlimited)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : result === "maxSubagentDepth"
            ? "Nested depth (0/1 = nesting off)"
            : "Grace turns (1+)";

    // Loop until user enters a valid integer or cancels (Esc / null).
    // Silently trims whitespace; rejects non-numeric input by re-prompting.
    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const n = Number(trimmed);
      if (trimmed !== "" && Number.isInteger(n)) {
        applyValue(result, String(n));
        await showSettings(ctx, deps);
        return;
      }
      // Invalid — re-prompt with the user's last entry so they can edit it
      input = await ctx.ui.input(label, trimmed);
    }
  }
}
