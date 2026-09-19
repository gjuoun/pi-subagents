/**
 * session-lifecycle.ts — what this extension does when a session starts, switches or ends.
 *
 * Three handlers, and they are one story: the first bound session_start captures the ctx, wires the
 * cross-extension RPC surface and broadcasts readiness (a session pi filtered out never reaches
 * here and must not advertise, #142); a switch drops what the previous session left; shutdown
 * aborts every agent, drops the registry entries this activation published, and awaits the children
 * so their own shutdown handlers run before the process exits (#242).
 *
 * Moved out of app.ts. It takes the activation's own context and services — extension/ is wiring and
 * may name them — and the domains it drives as callbacks, so a filtered-out activation still never
 * reaches the code that would advertise it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent/agent-manager.js";
import { registerRpcHandlers } from "../agent/rpc.js";
import { getAgentConfig, getAvailableTypes, getConfig } from "../config/registry/agent-types.js";
import type { AgentRecord } from "../lib/types.js";
import type { ModelScope } from "../model/model-scope.js";
import type { SubagentScheduler } from "../schedule/schedule.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "../ui/agent-mention.js";
import type { AgentStatusBar } from "../ui/agent-status-row.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/run/task.js";
import type { ActivationContext } from "./context.js";

export interface SessionLifecycleDeps {
  pi: ExtensionAPI;
  /** The activation's mutable state: the bound ctx, the RPC handle, the once-per-activation guards. */
  context: ActivationContext;
  /** Structural, like every slice: `services` belongs to the wiring layer, which `extension/` cannot name. */
  services: {
    status: Pick<AgentStatusBar, "setUICtx">;
    fleet: Pick<FleetList, "setUICtx" | "dispose">;
    manager: AgentManager;
    modelScope: ModelScope;
    scheduler: SubagentScheduler;
    /** Every run this session started, and every notification still held. */
    workflowTasks: Map<string, WorkflowTask>;
    pendingNudges: Map<string, ReturnType<typeof setTimeout>>;
  };
  /** The manager registry this activation published, plus the two spawn paths the RPC surface calls. */
  registry: {
    MANAGER_KEY: symbol;
    MANAGERS_KEY: symbol;
    registryEntry: object;
    ownsManagerRegistry: boolean;
    spawnTopLevel: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
    resolveAgentRef(ref: string): AgentRecord | undefined;
  };
  /** Held notifications: a result consumed through the RPC surface cancels its own. */
  notify: { cancelNudge(id: string): void };
  /** Bound calls: the domains own these, the lifecycle decides when they run. */
  startScheduler(ctx: ExtensionContext): void;
  resolveWorkflowCollisions(ctx: ExtensionContext): void;
  runWorkflowFlag(ctx: ExtensionContext): void;
}

export function registerSessionLifecycle(deps: SessionLifecycleDeps): void {
  const { pi, context, services, registry } = deps;

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    context.currentCtx = ctx;
    // Publish this activation's entry under its own session id too (see MANAGERS_KEY).
    const existingManagers = (globalThis as any)[registry.MANAGERS_KEY] as Map<string, unknown> | undefined;
    const sessionManagers = existingManagers ?? new Map<string, unknown>();
    (globalThis as any)[registry.MANAGERS_KEY] = sessionManagers;
    const ownSessionId = ctx.sessionManager?.getSessionId?.();
    if (ownSessionId) sessionManagers.set(ownSessionId, registry.registryEntry);
    if (ctx.hasUI) {
      services.status.setUICtx(ctx.ui);
      services.fleet.setUICtx(ctx.ui as any);
    }
    services.manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!context.rpcHandle) {
      context.rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => context.currentCtx,
        modelScope: services.modelScope,
        manager: {
          spawn: registry.spawnTopLevel,
          awaitStartup: (id) => services.manager.awaitStartup(id),
          getRecord: (id) => services.manager.getRecord(id),
          // Unguarded on purpose: the stop handler now runs the top-level check
          // itself off `getRecord`, and reports the refusal instead of the
          // "Agent not found" a false from here used to be read as.
          abort: (id) => services.manager.abort(id),
          consumeResult: (id) => {
            const record = registry.resolveAgentRef(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record || record.parentAgentId) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            deps.notify.cancelNudge(record.id);
            return true;
          },
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (context.schedulingEnabled && !services.scheduler.isActive()) deps.startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !context.mentionProviderRegistered) {
      context.mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(services.manager, mentionTypes(), type => getConfig(type).displayName),
          () => context.isAgentMentionsEnabled(),
        ),
      );
    }
    // Last, and only here: CLI flag values are applied by the host AFTER every
    // extension factory has run, so this is the earliest point the real value
    // exists. Detached inside — a workflow must not hold up session startup.
    deps.resolveWorkflowCollisions(ctx);
    deps.runWorkflowFlag(ctx);
  });

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("session_before_switch", () => {
    services.manager.clearCompleted(true);
    services.scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    context.rpcHandle?.unsubSpawn();
    context.rpcHandle?.unsubStop();
    context.rpcHandle?.unsubPing();
    context.rpcHandle?.unsubConsume();
    context.rpcHandle = undefined;
    context.currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (registry.ownsManagerRegistry && (globalThis as any)[registry.MANAGER_KEY] === registry.registryEntry) {
      delete (globalThis as any)[registry.MANAGER_KEY];
    }
    // Drop only this activation's per-session entries; every other session keeps its own.
    const sessionManagers = (globalThis as any)[registry.MANAGERS_KEY] as Map<string, unknown> | undefined;
    if (sessionManagers) {
      for (const [sessionId, entry] of sessionManagers) {
        if (entry === registry.registryEntry) sessionManagers.delete(sessionId);
      }
    }
    services.scheduler.stop();
    // Before abortAll, and not folded into it: a workflow owns a worker thread
    // as well as its children, and only its own signal terminates that.
    for (const task of services.workflowTasks.values()) task.abortController.abort();
    services.workflowTasks.clear();
    services.manager.abortAll();
    for (const timer of services.pendingNudges.values()) clearTimeout(timer);
    services.pendingNudges.clear();
    services.fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await services.manager.dispose(pi);
  });
}
