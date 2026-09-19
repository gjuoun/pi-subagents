/**
 * resume.ts — launching a detached resume of an agent that already has a session.
 *
 * Everything a re-running agent needs: transcript anchoring, activity tracking, join-mode
 * batching, the status/fleet refresh and the `subagents:created` event. Shared by the Agent
 * tool's `resume` + `run_in_background` branch and the mention path — they differ only in how they
 * report the outcome.
 *
 * Moved out of app.ts, which the callers already treated as a dependency: both were handed this
 * function, so only its home changed. It takes `AgentManager` rather than a hand-rolled resume
 * signature, since agent/ may name its own type; the batch window it joins is a callback, because
 * the window now belongs to the completion policy.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, JoinMode } from "../../lib/types.js";
import type { AgentActivity } from "../../lib/ui/theme.js";
import { createActivityTracker } from "../activity.js";
import type { AgentManager } from "../agent-manager.js";
import { resolveJoinMode } from "../invocation.js";
import { createOutputFilePath, ensureOutputFile, streamToOutputFile } from "./output-file.js";

export interface BackgroundResumeDeps {
  pi: ExtensionAPI;
  /** The run is started through it, and the record looked up while it starts. */
  manager: AgentManager;
  /** Live activity per agent id. A resume has no `onSessionCreated`, so its state is seeded here. */
  agentActivity: Map<string, AgentActivity>;
  /** The status row and the fleet list, both told the run started. */
  status: { markRunning(id: string): void; ensureTimer(): void; update(): void };
  fleet: { update(): void; ensureTimer(): void };
  /** Read live: the setting can change between two resumes. */
  defaultJoinMode(): JoinMode;
  /** Enter the batch window, so a resumed run is announced with its batch like any other spawn. */
  joinBatch(id: string, joinMode: JoinMode): void;
}

export function createBackgroundResume(deps: BackgroundResumeDeps) {
  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking, join-mode
   * batching, the widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` + `run_in_background` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined> {
    const id = existing.id;
    const joinMode = resolveJoinMode(deps.defaultJoinMode(), true);
    // Assigned unconditionally: the completion notification carries this as
    // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
    // id left by the spawn that created the record. Keeping it would point the
    // orchestrator's new result at a tool call that was answered runs ago.
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    // resumeAgent has no onSessionCreated — the session predates this run —
    // so seed it directly, or the widget shows no context % for the agent.
    bgState.session = existing.session;

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
    const record = await deps.manager.resume(id, prompt, undefined, {
      isBackground: true,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = deps.manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    if (joinMode != null && joinMode !== 'async') deps.joinBatch(id, joinMode);

    deps.agentActivity.set(id, bgState);
    // This agent already finished once, so the status row holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    deps.status.markRunning(id);
    deps.status.ensureTimer();
    deps.status.update();
    // The FleetView is the only agent surface now, so a run started on this path has to refresh
    // it here — otherwise the agent stays invisible until some later event repaints the list.
    deps.fleet.update();
    deps.fleet.ensureTimer();
    deps.fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
    deps.pi.events.emit("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  }

  return startBackgroundResume;
}
