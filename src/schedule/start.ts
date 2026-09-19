/**
 * start.ts — bringing this session's scheduler up.
 *
 * Moved out of app.ts. Scheduling is non-essential: a session whose `.pi/` directory is
 * unwritable must still get every other surface, so the failure is logged and swallowed here
 * rather than taken out on the whole activation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent/agent-manager.js";
import type { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";

export interface StartSchedulerDeps {
  pi: ExtensionAPI;
  /** The scheduler the services scope built for this activation. */
  scheduler: SubagentScheduler;
  /** Every scheduled job spawns through it. */
  manager: AgentManager;
}

  export function startScheduler(deps: StartSchedulerDeps, ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      deps.scheduler.start(deps.pi, ctx, deps.manager, store);
      deps.pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }
