/**
 * workflow.ts — the `SubagentWorkflow` tool and the plumbing behind a run.
 *
 * `runWorkflowTask` is the half that touches the host: it builds the workflow host, streams
 * progress into the task, and settles the record either way. It is exported because
 * `--subagents-workflow-file` — read in `index.ts`, the only place the real flag value exists —
 * runs a script through this same path. `fleetWorkflows` is the fleet list's view of the runs.
 *
 * The definition is unconditional and registration is not: whether pi is ever told about the
 * tool is the whole of the `workflowsEnabled` switch, and the collision stand-down has to be
 * able to undo the registration rather than skip it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { renderToolDescriptionTemplate } from "../agent/description.js";
import { sessionTaskDir } from "../agent/session/output-file.js";
import { isWorktreeIsolationEnabled } from "../agent/session/worktree.js";
import { SUBAGENT_TOOL_NAMES } from "../lib/tool-names.js";
import { type NotificationDetails } from "../lib/types.js";
import { type FleetWorkflow } from "../ui/fleet-list.js";
import { textResult } from "../ui/notifications.js";
import { renderWorkflowCard } from "../ui/workflow/workflow-card.js";
import { readJournal } from "../workflow/run/journal.js";
import { elapsedMs } from "../workflow/run/progress.js";
import { createWorkflowTask, formatWorkflowNotification, resolveResumeTarget, type WorkflowTask, workflowResultText, workflowRunId } from "../workflow/run/task.js";
import { runWorkflowTask } from "../workflow/run/task-runner.js";
import { extractMeta, type WorkflowMeta, workflowCallName } from "../workflow/script/meta.js";
import { resolveWorkflowScript } from "../workflow/script/saved.js";
import { fullWorkflowToolDescription } from "../workflow/tool-description.js";
import type { ToolsDeps } from "./deps.js";

/**
 * Workflow runs as the fleet list wants them.
 *
 * Mapped here rather than handing `WorkflowTask` over the seam: the list is
 * deliberately ignorant of the workflow engine, and a run's counters live in
 * the progress log rather than on the record, so they are derived per call
 * the same way the card derives them.
 */
export function fleetWorkflows(deps: ToolsDeps): FleetWorkflow[] {
  // Cached counters only, no derivation: the fleet list calls this on a
  // 200ms tick and reads the roster several times per update, so walking a
  // run's progress log here would put O(log) work in the render loop.
  return [...deps.services.workflowTasks.values()].map(task => ({
    id: task.id,
    name: task.meta?.name ?? task.workflowName ?? task.id,
    status: task.status,
    doneCount: task.doneCount,
    totalCount: task.agentCount,
    startedAt: task.startTime,
    ...(task.endTime !== undefined ? { completedAt: task.endTime } : {}),
    tokens: task.totalTokens,
  }));
}


/**
 * Hand a finished run back to the model through the SAME channel a background
 * agent uses — held briefly by `scheduleNudge`, delivered as a follow-up that
 * triggers a turn, rendered by the existing `subagent-notification` renderer.
 */
function notifyWorkflowFinished(deps: ToolsDeps, task: WorkflowTask) {
  deps.services.status.update();
  deps.services.fleet.update();
  const result = workflowResultText(task);
  deps.scheduleNudge(task.id, () => {
    deps.pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: formatWorkflowNotification(task),
      display: true,
      details: {
        id: task.id,
        description: `Workflow ${task.workflowName ?? task.id}`,
        status: task.status === "completed" ? "completed" : task.status === "killed" ? "stopped" : "error",
        toolUses: task.totalToolCalls,
        // A workflow has agents, not turns; rendering "↻0" would be noise.
        turnCount: 0,
        totalTokens: task.totalTokens,
        durationMs: elapsedMs(task, Date.now()),
        error: task.error,
        resultPreview: result.length > 500 ? `${result.slice(0, 500)}…` : result,
      },
    }, { deliverAs: "followUp", triggerTurn: true });
  });
}

export function createWorkflowTool(deps: ToolsDeps) {
// Defined unconditionally, registered only when the feature is on — the same
// shape the Agent tool uses. Keeping the definition out of the `if` means the
// switch changes exactly one thing: whether pi is ever told about the tool.
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.WORKFLOW,
    label: "SubagentWorkflow",
    description: renderToolDescriptionTemplate(fullWorkflowToolDescription, {
      schedulingEnabled: deps.context.schedulingEnabled,
      worktreeIsolation: isWorktreeIsolationEnabled(),
    }),
    promptSnippet: "Run a deterministic script that orchestrates many subagents",
    promptGuidelines: [
      "Use SubagentWorkflow when the number of agents depends on something discovered at runtime, when work flows through stages, or when findings should be independently verified. Use Agent for one delegated task or a handful you can name up front.",
      "Prefer `pipeline` over `parallel` — a barrier costs wall-clock whenever the stages are unevenly sized.",
      "A workflow runs in the background and notifies you when it finishes — do not poll or sleep waiting for it.",
    ],
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          maxLength: 524288,
          description: "Inline workflow source. Must begin with `export const meta = { name, description }`.",
        }),
      ),
      scriptPath: Type.Optional(
        Type.String({
          description:
            "Path to a workflow script file, absolute or relative to the project. Takes precedence over `script` — this is how you re-run an edited workflow.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Name of a saved workflow — `<name>.js` in .pi/workflows/, .agents/workflows/ or the user's agent dir. Lowest precedence: `scriptPath` and `script` both win over it.",
        }),
      ),
      args: Type.Optional(
        Type.Any({
          description: "Exposed to the script as the global `args`, verbatim. Must be JSON-shaped.",
        }),
      ),
      resumeFromRunId: Type.Optional(
        Type.String({
          pattern: "^wf_[a-z0-9-]{6,}$",
          description:
            "Run id of an earlier workflow in this session. Its unchanged leading agent() calls return their recorded results instantly; the first changed or failed call, and everything after it, runs live. Same script and args means nothing re-runs.",
        }),
      ),
      // Accepted and ignored, as in Claude Code. Models reach for them because
      // every other tool has them, and a hard schema rejection would cost a
      // whole turn to re-emit a script that was already correct. The `meta`
      // block is the one place a workflow is named.
      title: Type.Optional(
        Type.String({ description: "Ignored — set the workflow title in the script's `meta` block." }),
      ),
      description: Type.Optional(
        Type.String({ description: "Ignored — set the workflow description in the script's `meta` block." }),
      ),
    }),

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", "▸ ")}${theme.bold(theme.fg("toolTitle", "SubagentWorkflow"))}  ${theme.fg("muted", workflowCallName(args))}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const taskId = (result.details as { taskId?: string } | undefined)?.taskId;
      const task = taskId !== undefined ? deps.services.workflowTasks.get(taskId) : undefined;
      // No task means the run predates this session (a reloaded transcript) or
      // the call never started one — show what `execute` said instead.
      if (renderContext.isError || !task) return new Text(text, 0, 0);
      return renderWorkflowCard(
        {
          progress: task.workflowProgress,
          task: {
            status: task.status,
            workflowName: task.workflowName,
            startTime: task.startTime,
            endTime: task.endTime,
            totalPausedMs: task.totalPausedMs,
          },
          meta: task.meta,
          agentCount: task.agentCount,
          totalTokens: task.totalTokens,
        },
        theme,
      );
    },

    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const resumeFrom = resolveResumeTarget(params.resumeFromRunId, deps.services.workflowTasks);
      if (resumeFrom !== undefined && !resumeFrom.ok) return textResult(resumeFrom.message);

      // A resume with no source of its own re-runs what that run ran. The
      // common case is an edited script, but "run that again, cheaply" should
      // not require repeating a path the run already knows.
      const resolved = resolveWorkflowScript(
        params.script === undefined && params.scriptPath === undefined && params.name === undefined
          && resumeFrom !== undefined
          ? { scriptPath: resumeFrom.scriptPath }
          : params,
        ctx.cwd,
      );
      if (!resolved.ok) return textResult(resolved.message);

      // Parsed before anything is scheduled: a bad `meta` is an authoring error
      // the model can fix immediately, and reporting it as a background run
      // that failed a second later would just cost a turn.
      let meta: WorkflowMeta;
      try {
        meta = extractMeta(resolved.script).meta;
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const runId = workflowRunId();
      // Every invocation lands on disk next to the agent transcripts, so
      // iterating is edit-the-file-then-rerun-with-scriptPath rather than
      // re-emitting the whole source. The journal sits beside it under the same
      // id, which is what makes a run id enough to resume from.
      let savedPath: string | undefined;
      let journalPath: string | undefined;
      try {
        const dir = sessionTaskDir(ctx.cwd, ctx.sessionManager.getSessionId());
        savedPath = join(dir, `${runId}.workflow.js`);
        writeFileSync(savedPath, resolved.script, "utf-8");
        journalPath = join(dir, `${runId}.workflow.jsonl`);
      } catch (err) {
        savedPath = undefined;
        journalPath = undefined;
        console.warn(`[pi-subagents] could not persist workflow script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const replay = resumeFrom !== undefined ? readJournal(resumeFrom.journalPath) : undefined;

      const task = createWorkflowTask({
        id: runId,
        script: resolved.script,
        scriptPath: resolved.scriptPath ?? savedPath,
        args: params.args,
        meta,
        toolCallId,
        ...(journalPath !== undefined ? { journalPath } : {}),
        ...(replay !== undefined && replay.length > 0 ? { replay, resumedFrom: resumeFrom!.runId } : {}),
      });
      deps.services.workflowTasks.set(runId, task);
      // The run's own row has to appear now, not when it settles. Its agents
      // are owned by it, so their lifecycle callbacks no longer refresh these
      // surfaces — nothing else would register the widget for a run whose
      // first agent has not started yet.
      deps.services.status.update();
      deps.services.fleet.update();

      // Background, like Claude Code: the id comes back now and the run keeps
      // going without the tool call.
      void runWorkflowTask(deps, ctx, task).then(() => notifyWorkflowFinished(deps, task));

      return {
        content: [{
          type: "text" as const,
          text:
            `Workflow "${meta.name}" started in the background.\n` +
            `Task ID: ${runId}\n` +
            (task.scriptPath ? `Script: ${task.scriptPath}\n` : "") +
            (task.resumedFrom !== undefined
              ? `Resuming ${task.resumedFrom}: ${task.replay?.length ?? 0} recorded call(s) available to replay.\n`
              : params.resumeFromRunId !== undefined
                ? `Nothing to replay from ${params.resumeFromRunId} — every agent runs live.\n`
                : "") +
            `\nYou will be notified when it finishes — do NOT poll or sleep waiting for it.\n` +
            `To iterate, edit the script file and call SubagentWorkflow again with scriptPath.`,
        }],
        details: { taskId: runId },
      };
    },
  });
}
