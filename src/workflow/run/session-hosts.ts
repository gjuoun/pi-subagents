/**
 * session-hosts.ts — what a session does about workflows, at session_start.
 *
 * Two hosts, both triggered by the same event and both about this extension's *presence* rather
 * than about a run: withdraw the tool when the host already provides one (`resolveWorkflowCollisions`,
 * the host-facing shell around the policy in `workflow/collisions.ts`), and run a script a caller
 * passed with `--workflow` (`runWorkflowFlag`).
 *
 * Moved out of app.ts. It takes a structural slice rather than `ToolsDeps`: `workflow/` may not
 * import `tools/`, and the two wiring values it reads — the run deps and the tool's own
 * description, which is what the collision warning quotes — arrive as arguments.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAMES } from "../../lib/tool-names.js";
import { decideWorkflowCollision } from "../collisions.js";
import { extractMeta, type WorkflowMeta } from "../script/meta.js";
import { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG, type WorkflowEntryData, workflowEntryData } from "./entry.js";
import { createWorkflowTask, formatWorkflowNotification, type WorkflowTask, workflowRunId } from "./task.js";
import { runWorkflowTask, type WorkflowRunDeps } from "./task-runner.js";

/** What the hosts read from the activation. Fields marked mutable are written back — they are the once-per-session guards. */
export interface WorkflowHostDeps {
  pi: ExtensionAPI;
  services: {
    /** Every run this session has, by id. */
    workflowTasks: Map<string, WorkflowTask>;
    /** Repainted when a detached run settles. */
    status: { update(): void };
    fleet: { update(): void };
  };
  context: {
    workflowsEnabled: boolean;
    /** Whether the flag host may still claim this session's \`--workflow\`. */
    workflowsPinned: boolean;
    collisionsChecked: boolean;
    workflowFlagHandled: boolean;
  };
  /** Enough to drive a run — `ToolsDeps` satisfies it structurally. */
  runDeps: WorkflowRunDeps;
  /** The Workflow tool's description, quoted in the collision warning. */
  toolDescription: string;
}

export function createWorkflowHosts(deps: WorkflowHostDeps) {
  /**
   * Act on {@link decideWorkflowCollision} — the half that needs the host.
   *
   * The policy (what counts as a conflict, what a pin changes, whether there is
   * anything left to withdraw) lives in `workflow/collisions.ts`; this is the
   * host-facing shell around it: read the registry, warn, and take our tool out
   * of the active set.
   *
   * ## Why this can only happen at session_start
   *
   * `getAllTools` throws during extension loading ("Action methods cannot be
   * called during extension loading"), and load order means a check at
   * registration time could not see an extension that has not loaded yet. So
   * the decision cannot gate `registerTool`; it has to undo it. `setActiveTools`
   * is what makes that real rather than cosmetic — pi rebuilds the system
   * prompt from the new set, and `session_start` runs before any turn, so the
   * model never sees a spec we withdrew. A later `_refreshToolRegistry` keeps
   * the active set it had and only adds names new to the registry, so ours does
   * not creep back.
   *
   * Best-effort and swallowed. A diagnostic that took the session down would be
   * worse than the collision it reports.
   */
  function resolveWorkflowCollisions(ctx: ExtensionContext): void {
    if (deps.context.collisionsChecked) return;
    deps.context.collisionsChecked = true;

    const warn = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[pi-subagents] ${message}`);
    };

    try {
      if (!deps.context.workflowsEnabled) return;

      const verdict = decideWorkflowCollision({
        tools: deps.pi.getAllTools(),
        // Identifies our own registration: this extension does not know its
        // install path, and the description is the one field certainly ours.
        ownDescription: deps.toolDescription,
        pinned: deps.context.workflowsPinned,
      });
      if (verdict.kind === "none") return;
      if (verdict.kind === "report") {
        warn(verdict.message);
        return;
      }

      deps.context.workflowsEnabled = false; // not setWorkflowsEnabled: this is not the user pinning it
      deps.services.status.update();
      deps.services.fleet.update();
      warn(verdict.message);

      if (!verdict.withdraw) return;
      const active = deps.pi.getActiveTools();
      if (active.includes(SUBAGENT_TOOL_NAMES.WORKFLOW)) {
        deps.pi.setActiveTools(active.filter(name => name !== SUBAGENT_TOOL_NAMES.WORKFLOW));
      }
    } catch {
      // getAllTools/setActiveTools are unavailable in some hosts (print mode,
      // RPC). Not being able to check is not a reason to fail the session.
    }
  }

  /**
   * `--subagents-workflow-file=<path>` — run a script at startup, with no LLM
   * round-trip deciding whether to call the tool.
   *
   * Read here rather than at activation because that is the only place the real
   * value exists: the host activates extensions first and applies collected CLI
   * flags second, so `getFlag` during activation returns the registered default
   * and nothing else. `examples/extensions/ssh.ts` reads its flag from
   * session_start for exactly this reason.
   */
  function runWorkflowFlag(ctx: ExtensionContext): void {
    if (deps.context.workflowFlagHandled) return;
    const flag = deps.pi.getFlag(WORKFLOW_FILE_FLAG);
    if (flag === undefined || flag === false) return;
    deps.context.workflowFlagHandled = true;

    const report = (message: string, level: "info" | "warning") => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else console.warn(`[pi-subagents] ${message}`);
    };

    // The flag is the same machinery by another door, so the master switch has
    // to close it too — silently ignoring a flag the user typed would be worse
    // than saying why nothing ran.
    if (!deps.context.workflowsEnabled) {
      report(
        `--${WORKFLOW_FILE_FLAG} ignored: workflows are off. Turn them on in /agents → Settings → Workflows, ` +
          'or set `"workflowsEnabled": true` in .pi/subagents.json.',
        "warning",
      );
      return;
    }

    // A bare `--subagents-workflow-file` parses to boolean `true`. Say what was
    // missing rather than reading a file called "true".
    if (typeof flag !== "string" || flag.trim() === "") {
      report(`--${WORKFLOW_FILE_FLAG} needs a path: --${WORKFLOW_FILE_FLAG}=<path>`, "warning");
      return;
    }

    const path = isAbsolute(flag.trim()) ? flag.trim() : join(ctx.cwd, flag.trim());
    let script: string;
    try {
      script = readFileSync(path, "utf-8");
    } catch (err) {
      report(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }

    let meta: WorkflowMeta | undefined;
    try {
      meta = extractMeta(script).meta;
    } catch (err) {
      report(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const task = createWorkflowTask({ id: workflowRunId(), script, scriptPath: path, meta });
    deps.services.workflowTasks.set(task.id, task);
    deps.services.status.update();
    deps.services.fleet.update();
    report(`Running workflow ${meta.name}…`, "info");

    // Detached: session_start is awaited by the host, and a workflow can run for
    // minutes — blocking here would hold the whole session's startup.
    void runWorkflowTask(deps.runDeps, ctx, task).then(() => {
      // No tool call to attach a result card to, so the card becomes a session
      // entry (same layout), and the outcome is handed to the model as context
      // for its next turn rather than forcing one.
      deps.pi.appendEntry<WorkflowEntryData>(WORKFLOW_ENTRY_TYPE, workflowEntryData(task));
      deps.pi.sendMessage({
        customType: "workflow-result",
        content: formatWorkflowNotification(task),
        display: false,
      }, { deliverAs: "nextTurn" });
      deps.services.status.update();
      deps.services.fleet.update();
    });
  }

  return { resolveWorkflowCollisions, runWorkflowFlag };
}
