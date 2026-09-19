/**
 * task-runner.ts — running a workflow task to completion against the real manager.
 *
 * Moved out of tools/workflow.ts, where it sat because the tool was written first. The tool
 * *defines* the surface; driving a task is this domain's own work — it builds the host, streams
 * progress into the task, and settles the record either way. The tool imports it back.
 *
 * It takes a structural slice rather than `ToolsDeps` for the fence's reason: `workflow/` may
 * not import `tools/`. The handles it reads are named in `WorkflowRunDeps` below. The completion
 * notification is deliberately NOT here — the tool path and the session-start path report a
 * finished run differently, so each owns its own.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { ModelScope } from "../../model/model-scope.js";
import { createWorkflowHost } from "./host.js";
import { appendJournal, type WorkflowJournalEntry } from "./journal.js";
import { runWorkflow } from "./runtime.js";
import { completeWorkflowTask, failWorkflowTask, updateWorkflowProgressBatch, type WorkflowTask } from "./task.js";

/** What driving a run needs from the activation. Satisfied structurally by `ToolsDeps` and by the session-start host alike. */
export interface WorkflowRunDeps {
  pi: ExtensionAPI;
  services: {
    /** Handed to the host: every agent the script spawns runs under it. */
    manager: AgentManager;
    /** Handed to the host: which model a step resolves to. */
    modelScope: ModelScope;
    /** Repainted when the run starts and when it settles. */
    status: { update(): void };
    fleet: { update(): void };
  };
}

/**
 * Run a task to completion against the real manager, settling the record
 * either way. Never rejects: a run that cannot start (bad `meta`, oversized
 * source, non-JSON `args`) is a failed workflow, and both callers here are
 * detached — a rejection would surface as an unhandled one.
 */
export async function runWorkflowTask(deps: WorkflowRunDeps, ctx: ExtensionContext, task: WorkflowTask): Promise<void> {
  try {
    const result = await runWorkflow({
      script: task.script,
      args: task.args,
      signal: task.abortController.signal,
      host: createWorkflowHost({
        pi: deps.pi,
        ctx,
        manager: deps.services.manager,
        signal: task.abortController.signal,
        rootSessionId: ctx.sessionManager.getSessionId(),
        workflowId: task.id,
        modelScope: deps.services.modelScope,
      }),
      onProgress: entries => updateWorkflowProgressBatch(task, entries),
      // The dialog's pause / skip / retry keys run through this; it is dropped
      // again when the task settles.
      onControl: control => { task.control = control; },
      journal: {
        ...(task.replay !== undefined ? { entries: task.replay } : {}),
        ...(task.journalPath !== undefined
          ? { append: (entry: WorkflowJournalEntry) => appendJournal(task.journalPath!, entry) }
          : {}),
      },
    });
    completeWorkflowTask(task, result);
  } catch (err) {
    failWorkflowTask(task, err instanceof Error ? err.message : String(err));
  }
}
