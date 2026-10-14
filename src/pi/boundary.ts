import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ManagedRuntime } from "effect";
import { Cause, Effect, Exit, Option, Result } from "effect";
import { renderError, type V2Error } from "../domain/errors.js";

/**
 * boundary.ts — the ONE place an Effect becomes plain data for pi.
 *
 * No Effect, Exit, Cause or class instance may cross this line; runTool folds an Exit
 * into an AgentToolResult (or re-throws the original defect so pi marks the call errored).
 */

export interface RunToolOptions {
  /** Text shown when the run was interrupted (aborted). */
  readonly abortedText?: string;
}

export const DEFAULT_ABORTED_TEXT = "Agent was aborted.";

/** A tool's text plus plain-data details for its renderer. */
export interface ToolOutput {
  readonly text: string;
  readonly details: unknown;
}

const isToolOutput = (value: unknown): value is ToolOutput =>
  typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string" && "details" in value;

export async function runTool<A, E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  program: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
  options: RunToolOptions = {},
): Promise<AgentToolResult<unknown>> {
  const exit = await runtime.runPromiseExit(program, { signal });

  if (Exit.isSuccess(exit)) {
    const value: unknown = exit.value;
    return isToolOutput(value) ? { content: [{ type: "text", text: value.text }], details: value.details } : textResult(String(value));
  }

  // Read interrupts off the cause, not Exit.hasInterrupts — that one is a `self is Failure`
  // guard, so negating it after the isSuccess check above collapses `exit` to never.
  if (Cause.hasInterrupts(exit.cause)) {
    return textResult(options.abortedText ?? DEFAULT_ABORTED_TEXT);
  }

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    const error = failure.value as V2Error;
    return textResult(`Error [${error._tag}]: ${renderError(error)}`);
  }

  // No typed error and no interrupt: a defect (a bug). Re-throw the original value so
  // pi treats it as an errored tool call — never wrap it (the value is already throwable).
  const defect = Cause.findDefect(exit.cause);
  if (Result.isSuccess(defect)) {
    throw defect.success;
  }
  throw Cause.pretty(exit.cause);
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}
