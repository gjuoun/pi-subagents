/**
 * agent.ts — the `Agent` tool.
 *
 * The description and parameter schema are built at definition time, so they reflect the
 * persisted settings of this session rather than a compiled-in default. `execute` is the whole
 * dispatch state machine — schedule, resume, spawn, foreground or background — and
 * `renderCall`/`renderResult` draw the Claude Code-style block around it.
 *
 * Everything it reaches outside itself arrives as {@link ToolsDeps}.
 */

import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { isTopLevelAgent } from "../agent/agent-manager.js";
import { buildAgentToolDescription, buildScheduleParam } from "../agent/description.js";
import { isolationParam, resolveAgentInvocationConfig, resolveJoinMode } from "../agent/invocation.js";
import { getDefaultMaxTurns, normalizeMaxTurns } from "../agent/run-limits.js";
import { createOutputFilePath, getOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "../agent/session/output-file.js";
import { getForegroundOutcomeNote, partialOutputSuffix } from "../agent/session/status-note.js";
import { isWorktreeIsolationEnabled } from "../agent/session/worktree.js";
import { getAgentConfig, getAvailableTypes, resolveSpawnType, resolveType } from "../config/registry/agent-types.js";
import { THINKING_LEVELS } from "../lib/agent-meta.js";
import { SUBAGENT_TOOL_NAMES } from "../lib/tool-names.js";
import { type AgentInvocation, type AgentRecord, type SubagentType } from "../lib/types.js";
import { describeActivity, fgPreservingNestedStyles, formatCost, formatMs, formatTurns } from "../lib/ui/format.js";
import { type AgentDetails, type UICtx } from "../lib/ui/theme.js";
import { getLifetimeCost } from "../lib/usage.js";
import { describeModel, resolveModel } from "../model/model-resolver.js";
import { checkModelScope } from "../model/model-scope.js";
import { renderAgentName } from "../ui/agent-color.js";
import { buildInvocationTags, getDisplayName, getPromptModeLabel } from "../ui/agent-display.js";
import { createActivityTracker, formatLifetimeTokens, renderRunningAgentStatus } from "../ui/agent-status.js";
import { SPINNER } from "../ui/agent-widget.js";
import { buildDetails, textResult } from "../ui/notifications.js";
import type { ToolsDeps } from "./deps.js";

export function createAgentTool(deps: ToolsDeps) {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: buildAgentToolDescription(deps.context.toolDescriptionMode, {
      schedulingEnabled: deps.context.isSchedulingEnabled(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
    }),
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...buildScheduleParam(deps.context.isSchedulingEnabled()),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      // A badge closes its own background, which would clear the tool block's row tint
      // for the rest of the line, so the badge restores it. The tint is opened here too:
      // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
      // background the line never opened is what banded the export before. The line is
      // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
      // wraps, so closing here would leave that padding untinted, and HTML export closes
      // any open span per line anyway. No badge means no tint, so an uncolored agent
      // renders exactly the line it always did.
      // Always tinted, badge or not: pi's box paints the block's state background and the badge
      // has to restore it mid-line, so an agent with no configured colour still reads as a tool
      // block — pending while it runs, success or error once it settles.
      const rowBackground = theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg");
      const desc = args.description ?? "";
      const name = renderAgentName(args.subagent_type, theme, {
        fallbackColor: "toolTitle",
        restoreBackground: rowBackground,
        bold: true,
      });
      return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details as AgentDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      /**
       * The result lines carry the same state background pi paints the call line with — pending
       * while the run streams, error once it failed, success otherwise. Without it a block whose
       * call is tinted and whose result is not reads as two different objects rather than one.
       */
      const status = details?.status;
      const bgColor: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" =
        isPartial || status === "running"
          ? "toolPendingBg"
          : renderContext.isError || status === "error" || status === "aborted" || status === "stopped"
            ? "toolErrorBg"
            : "toolSuccessBg";
      // A theme with no background painter (test doubles, an embedded session) renders the line
      // plain rather than failing — the tint is decoration, the text is the result.
      const row = typeof theme.bg === "function"
        ? (line: string) => new Text(line, 0, 0, (t: string) => theme.bg(bgColor, t))
        : (line: string) => new Text(line, 0, 0);
      // Pi reports pre-execution failures (extension block, abort, argument
      // validation) as `{ content: [reason], details: {} }` with isError set —
      // no status to render, so show the reason instead of inventing one (#199).
      if (renderContext.isError || !details?.status) {
        return row(text);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        if (deps.context.showCost) {
          const costText = formatCost(d.cost ?? 0);
          if (costText) parts.push(costText);
        }
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme, "toolPendingBg");
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return row(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`));
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return row(line);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return row(line);
      }

      // Anything left ("queued", or a status added later) has no rendering of
      // its own — the turn-limit wording below must not be the catch-all.
      if (details.status !== "error" && details.status !== "aborted") {
        return row(text);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return row(line);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      deps.context.widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      deps.reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // once persisted an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Computed at resolution rather than after the run, so the background and
      // schedule branches carry it too — previously it existed only on the
      // foreground path. Resume deliberately doesn't: it replays the stored
      // session and ignores `subagent_type` entirely, so a note about type
      // substitution would be describing something that didn't happen.
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
        ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
        : "";

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: deps.context.getBackgroundByDefault(),
      });

      // Resolve model from agent config first; tool-call params only fill gaps.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts so the nested delegation tools apply the same rule.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      // Unconditional, not "only when it differs from the parent": a thinking
      // level reads as a property of a model, and an agent that inherited the
      // parent's model used to show the level with nothing to attach it to.
      // This is the pre-session snapshot — agent-manager overwrites it with the
      // effective values the moment a session reports them.
      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
      // What the caller SPELLED, kept only if it names a different model than the
      // one that won. Model input is fuzzy — `"haiku"` and
      // `"anthropic/claude-haiku-4-5"` are the same model — so comparing the two
      // strings would disclose an override that never happened. A spelling that
      // resolves to nothing is still worth disclosing: it cannot have taken effect.
      const askedModel = ((asked: string | undefined) => {
        if (!asked) return undefined;
        const resolvedAsked = resolveModel(asked, ctx.modelRegistry);
        if (typeof resolvedAsked === "string") return asked;
        return resolvedAsked.provider === model?.provider && resolvedAsked.id === model?.id ? undefined : asked;
      })(resolvedConfig.overridden?.model);
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        // Only set where the agent file outranked the caller, so the surfaces can
        // disclose a parameter that was accepted but could not take effect (#182).
        requestedThinking: resolvedConfig.overridden?.thinking,
        requestedModel: askedModel,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };
      // Tool-result render shows the mode label too; viewer's header already does.
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      /**
       * `detailBase` for a record that exists, which outranks it: the base is a
       * snapshot of what this call REQUESTED, and pi may have resolved a
       * different model or clamped the thinking level (agent-manager writes the
       * effective values back when the session reports them). Resume goes
       * further and ignores the model/thinking parameters outright — it runs on
       * the session it is reopening — so rendering the base there advertises
       * settings the run never used.
       *
       * The mode label is rebuilt rather than carried over: it hangs off the
       * agent TYPE, not the invocation, so tags taken straight from
       * buildInvocationTags would silently drop `twin`.
       */
      const detailBaseFor = (rec: AgentRecord | undefined): typeof detailBase => {
        if (!rec?.invocation) return detailBase;
        const type = rec.type;
        const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
        const recModeLabel = getPromptModeLabel(type);
        const recTags = recModeLabel ? [recModeLabel, ...tags] : tags;
        return {
          displayName: getDisplayName(type),
          description: rec.description,
          subagentType: type,
          modelName: recModelName,
          tags: recTags.length > 0 ? recTags : undefined,
        };
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!deps.context.isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (params.run_in_background === false) {
          return textResult("Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.");
        }
        if (!deps.context.scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = deps.context.scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = deps.context.scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Resume existing agent
      if (params.resume) {
        const existing = deps.context.manager.getRecord(params.resume);
        if (!existing || !isTopLevelAgent(existing)) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }

        // Background resume: detached run that notifies on completion, mirroring
        // a background spawn. Previously run_in_background was silently ignored
        // on resume (this branch returned before the background branch below),
        // so a resumed agent always blocked the main loop until it finished.
        if (runInBackground) {
          const id = existing.id;
          // A detached resume hands control back while the record stays
          // "running", so nothing stops the model from resuming the same agent
          // again mid-run. manager.resume() refuses that (it would orphan the
          // live run's abort controller); say why here, where the model can act
          // on it, instead of letting it read as a generic failure.
          if (existing.status === "running" || existing.status === "queued") {
            return textResult(
              `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
              `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
            );
          }

          const record = await deps.startBackgroundResume(ctx, existing, params.prompt, {
            outputTranscript,
            maxTurns: effectiveMaxTurns,
            toolCallId,
          });
          if (!record) {
            return textResult(`Failed to resume agent "${params.resume}".`);
          }

          const isQueued = record.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${existing.type}\n` +
            (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued ? `Position: queued (max ${deps.context.manager.getMaxConcurrent()} concurrent)\n` : "") +
            `\nYou will be notified when this agent completes.\n` +
            `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
            { ...detailBaseFor(record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
          );
        }

        const record = await deps.context.manager.resume(params.resume, params.prompt, signal);
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        // A failed resume surfaces the error, plus any partial output THIS
        // resume produced (never the previous turn's answer, #144).
        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBaseFor(record), record));
        }
        return textResult(
          record.result?.trim() || "No output.",
          buildDetails(detailBaseFor(record), record),
        );
      }

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = deps.context.manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks a
        // tool call failed only when execute throws, and a returned message
        // reads to the model as a subagent that ran and reported this (#179).
        id = deps.context.manager.spawn(deps.pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...bgCallbacks,
        });

        // Set output file + join mode synchronously after spawn, before the
        // event loop yields — onSessionCreated is async so this is safe.
        const joinMode = resolveJoinMode(deps.context.defaultJoinMode, true);
        const record = deps.context.manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        // With isolation: "worktree" the agent isn't running yet — the repo
        // copy is an awaited git call. Wait for it here, after the synchronous
        // wiring above, so a strict-isolation failure still fails THIS tool
        // call instead of being reported as a subagent that ran (#179).
        await deps.context.manager.awaitStartup(id);

        if (joinMode == null || joinMode === 'async') {
          // Foreground/no join mode or explicit async — not part of any batch
        } else {
          // smart or group — add to current batch
          deps.context.currentBatchAgents.push({ id, joinMode });
          // Debounce: reset timer on each new agent so parallel tool calls
          // dispatched across multiple event loop ticks are captured together
          if (deps.context.batchFinalizeTimer) clearTimeout(deps.context.batchFinalizeTimer);
          deps.context.batchFinalizeTimer = setTimeout(deps.finalizeBatch, 100);
        }

        deps.context.agentActivity.set(id, bgState);
        deps.context.widget.ensureTimer();
        deps.context.widget.update();
        deps.context.fleet.ensureTimer();
        deps.context.fleet.update();

        // Emit created event
        deps.pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${deps.context.manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBaseFor(record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      // Set only while the spawn is parked on a foreground concurrency slot
      // (maxConcurrentForeground); undefined the rest of the time, including
      // always when the limit is unset.
      let queuedAhead: number | undefined;

      const streamUpdate = () => {
        // Spend from the record, everything else from the live tracker. `fgId`
        // is set in onSessionCreated below, which fires before the first
        // assistant message — so nothing is spent while this reads zero.
        const fgRecord = fgId ? deps.context.manager.getRecord(fgId) : undefined;
        const details: AgentDetails = {
          ...detailBaseFor(fgRecord),
          toolUses: fgState.toolUses,
          tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
          cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          // Deliberately still "running" while queued: the renderer routes any
          // status it doesn't know to raw text (see the catch-all below), which
          // would drop the spinner and read as hung. Only the activity line
          // changes — "thinking…" would be a lie for an agent that has not
          // started and may not for minutes.
          status: "running",
          activity: queuedAhead === undefined
            ? describeActivity(fgState.activeTools, fgState.responseText)
            : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

      // Wire session creation: register in widget + stream to output file.
      // The output file path is set synchronously after spawn (below),
      // before onSessionCreated fires — same pattern as background agents.
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        // It really started — stop reporting it as queued, and repaint now
        // rather than leaving the stale line up for the next spinner tick.
        // Guarded, so a spawn that never queued emits no extra update.
        if (queuedAhead !== undefined) {
          queuedAhead = undefined;
          streamUpdate();
        }
        for (const a of deps.context.manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            deps.context.agentActivity.set(a.id, fgState);
            deps.context.widget.ensureTimer();
            deps.context.fleet.ensureTimer();
            deps.context.fleet.update();
            break;
          }
        }
        // Stream conversation to output file (foreground agent logging)
        if (fgId) {
          const rec = deps.context.manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      let record: AgentRecord;
      try {
        const fgResult = await deps.context.manager.spawnAndWait(deps.pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          // Deliberately does NOT set fgId: that drives agentActivity, the
          // widget and the `finally` cleanup below, none of which should see an
          // agent that has no session and may never get one.
          onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
          ...fgCallbacks,
        }, (fgAgentId) => {
          // onSpawned: called synchronously after spawn, before onSessionCreated fires.
          // Set up the output file so streamToOutputFile can pick it up.
          const fgRec = deps.context.manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
        });
        record = fgResult.record;
      } finally {
        // Runs on both paths, so a startup throw — which now propagates, see
        // the background spawn above (#179) — no longer leaves the spinner
        // ticking or a finished agent on the widget.
        clearInterval(spinnerInterval);
        if (fgId) {
          deps.context.agentActivity.delete(fgId);
          deps.context.widget.markFinished(fgId);
          deps.context.fleet.onAgentFinished(fgId);
        }
      }

      // Get final token count — from the record, like the cost below it, so the
      // two describe the same work when the agent delegated to nested children.
      const tokenText = formatLifetimeTokens(record);

      const details = buildDetails(detailBaseFor(record), record, fgState, { tokens: tokenText });

      if (record.status === "error") {
        // Error headline + any partial output the run produced before failing.
        return textResult(`${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      if (deps.context.showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(costText);
      }
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });
}
