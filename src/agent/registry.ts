/**
 * registry.ts — the spawn funnel and the process-wide manager registry.
 *
 * Every programmatic spawn lands here: the cross-extension RPC, both `@handle` mention paths, and
 * the `Symbol.for()` registry below. None of them came through the Agent tool, which is where the
 * activity tracker is otherwise created — so the funnel builds one itself (#181).
 *
 * Moved out of app.ts, where it was the activation body's first third. It owns no activation
 * state: the manager and the activity map arrive as handles, and re-scanning the agent dirs is a
 * callback, because `reloadCustomAgents` also re-registers on a settings write and that caller is
 * the lifecycle's, not this one's.
 */

import { resolveSpawnType } from "../config/registry/agent-types.js";
import type { AgentRecord } from "../lib/types.js";
import type { AgentActivity } from "../lib/ui/theme.js";
import { createActivityTracker } from "./activity.js";
import type { AgentManager } from "./agent-manager.js";
import { isTopLevelAgent } from "./agent-manager.js";
import { resolveEffectiveMaxTurns } from "./run-limits.js";

export interface ManagerRegistryDeps {
  services: {
    manager: AgentManager;
    /** The live activity state per agent id, created here for spawns that bypass the Agent tool. */
    agentActivity: Map<string, AgentActivity>;
  };
  /** Re-scan the agent dirs before resolving a type, so a file added mid-session is spawnable here too. */
  reloadAgents(): void;
}

export function createManagerRegistry(deps: ManagerRegistryDeps) {
  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  // Documented for callers in docs/rpc.md ("The manager registry").
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  /**
   * Per-session view of the same entry, keyed by session id.
   *
   * The single slot above is claimed by the FIRST activation in the process and released only when
   * that one shuts down, which is exactly right for the case it was written for — a child session
   * re-activating this extension must not point cross-package consumers at a short-lived child
   * manager. But a host that keeps MANY sessions in one process (a web UI, a daemon) then resolves
   * `undefined` for its own agent ids in every session but the first: `getRecord(id)` walks the
   * owner's manager. Publishing each activation under its own session id is additive — the legacy
   * slot keeps its exact semantics — and lets such a host resolve the ids it spawned, including
   * `record.sessionFile` and the live `record.session`. Documented in docs/rpc.md.
   */
  const MANAGERS_KEY = Symbol.for("pi-subagents:managers");
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    deps.reloadAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    const { state, callbacks } = createActivityTracker(resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns));
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    const id = deps.services.manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, ...callbacks });
    deps.services.agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    // Internal too: a forged value would hide an RPC-spawned agent inside
    // someone else's workflow, and take it out of the concurrency pool with it.
    delete safeOptions.workflowId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Every spawn through here is DETACHED — the caller gets an id back and
    // awaits nothing. A forged `blocking` would charge it to the foreground
    // pool and could defer it behind a queue whose gate nobody is holding.
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = deps.services.manager.getRecord(ref);
    if (byId) return byId;
    const resolved = deps.services.manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => deps.services.manager.waitForAll(),
    hasRunning: () => deps.services.manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = deps.services.manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) ? record : undefined;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  return { MANAGER_KEY, MANAGERS_KEY, spawnResolved, spawnTopLevel, resolveAgentRef, registryEntry, ownsManagerRegistry };
}
