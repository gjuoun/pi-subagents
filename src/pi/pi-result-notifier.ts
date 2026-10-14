import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { ResultNotifier } from "../services/result-notifier.js";

/**
 * pi-result-notifier.ts — the live ResultNotifier over the pi handle.
 *
 * The only way a subagent result reaches the parent: a custom message delivered as a follow-up
 * that triggers a parent turn.
 */

export const ResultNotifierLive = (pi: ExtensionAPI): Layer.Layer<ResultNotifier> =>
  Layer.succeed(ResultNotifier, {
    deliver: (message) =>
      Effect.sync(() => {
        pi.sendMessage(message.toOutbound(), { deliverAs: "followUp", triggerTurn: true });
      }),
  });
