/**
 * mention-clone.ts — start a mentioned agent through a clone of this conversation,
 * without putting anything in the chat.
 *
 * The clone is built by pi's `buildSessionContext()` — not the session file, which
 * `_persist` leaves empty until the first assistant message lands — and takes one
 * off-screen turn with the *registered* `Agent` tool, re-bound to the main
 * `ExtensionContext`, called with no tool-call id and forced into the background.
 * The spawn belongs to the real session, not the fork. Its `thinkingLevel` is
 * ignored: it reads "off" unless someone ran `/think`, so omitting the field lets
 * `createAgentSession` resolve the level actually in use.
 *
 * One tool, one job: the clone cannot read, write or run anything.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  createAgentSession,
  type ExtensionContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "../../lib/child-context.js";
import type { SubagentType, ThinkingLevel } from "../../lib/types.js";
import { agentMentionReminder } from "./mention.js";

export interface MentionCloneOptions {
  /** The MAIN session's context — what the spawn is attributed to, and the
   * source of both the conversation and the live system prompt. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone actually called `Agent`. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, _cloneCtx) => {
      // One spawn per mention. The clone has a single tool and every reason to
      // stop after using it, but a model that decides to "also" launch a second
      // agent would do it where nobody can see and nobody asked.
      if (spawned) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Already started an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        });
      }
      spawned = true;
      // undefined tool-call id + the main ctx: see the header. Background is
      // forced rather than left to the clone: `run_in_background` defaults to
      // false, and a foreground agent answers through its TOOL RESULT — which
      // here is delivered into a session that is disposed moments later, so the
      // agent would run, appear in the widget and the fleet, and reach nobody.
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), run_in_background: true } as typeof params,
        signal,
        onUpdate,
        ctx,
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // Pi 0.80.8 moved createAgentSession from modelRegistry to modelRuntime;
    // agent-runner.ts carries the same shim for the same reason — pass both so
    // the clone keeps the parent's providers across the supported range.
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
    // The conversation as the main session resolves it: compaction applied,
    // branch summaries substituted.
    const conversation = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    // Pi 0.82.0 added this; below it the field is absent and the clone takes
    // the settings level instead, which is what a session that never ran
    // `/think` is on anyway. Same shim shape as `modelRuntime` below.
    const thinkingLevel = (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel;
    const created = await runInChildSessionContext(() =>
      createAgentSession({
        cwd: ctx.cwd,
        // Nothing about the copy is worth persisting, and an in-memory manager
        // is also what keeps the real session untouched.
        sessionManager: SessionManager.inMemory(ctx.cwd),
        model: ctx.model as Model<never> | undefined,
        ...(thinkingLevel && { thinkingLevel }),
        modelRegistry: ctx.modelRegistry,
        ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
        // An allowlist naming exactly the clone's own tool. NOT `noTools:
        // "all"`, whose doc comment ("start with no tools enabled") reads like
        // it spares custom tools and does not: it resolves to an EMPTY
        // allowlist, and `isAllowedTool` then drops every tool from the
        // registry — the custom one included. The clone would be prompted with
        // nothing to call, answer in prose, and every mention would fall
        // through to the direct start with a warning. Same idiom as
        // agent-runner's `tools: sessionTools` beside its nested `customTools`.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      } as Parameters<typeof createAgentSession>[0]),
    );
    session = created.session;

    // The clone rebuilds a system prompt from cwd and agentDir, which is close
    // but not the live one — extensions contribute to it per turn. Copy the
    // real thing, so the copy reasons under the instructions the user's model
    // is actually working under.
    const systemPrompt = ctx.getSystemPrompt?.();
    if (systemPrompt) session.agent.state.systemPrompt = systemPrompt;

    // The conversation itself. Pushed rather than assigned so the array the
    // session was built around stays the one it goes on using.
    session.agent.state.messages.push(...conversation.messages);

    // User text first, reminder after — the order Claude Code's attachment
    // renderer produces, where the reminder trails the message it is about.
    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
