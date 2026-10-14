import { Context, type Effect } from "effect";
import type { SubagentResultMessage } from "../domain/subagent-result.js";

/**
 * result-notifier.ts — the port a settled subagent result is delivered through.
 *
 * The registry depends on this, never on the pi handle: the live layer
 * (pi/pi-result-notifier.ts) pushes a follow-up into the parent conversation, and tests
 * provide a stub.
 */

export interface ResultNotifierShape {
  /** Push a settled subagent result into the parent conversation. */
  readonly deliver: (message: SubagentResultMessage) => Effect.Effect<void>;
}

export class ResultNotifier extends Context.Service<ResultNotifier, ResultNotifierShape>()(
  "pi-subagents/v2/ResultNotifier",
) {}
