import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import type { SubagentResultMessage } from "./subagent-result-message.js";

/**
 * pi-host.ts — the thin, promise-free wrapper over the pi handle.
 *
 * PiHost is a v4 class service: the rest of v2src never touches ExtensionAPI directly, and
 * deliver() owns the one way a subagent result is pushed into the parent conversation.
 */

/** A plain message to push into the parent conversation. */
export interface PiOutboundMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
}

export interface PiSendOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface PiHostShape {
  readonly sendMessage: (message: PiOutboundMessage, options?: PiSendOptions) => void;
  /** Push a settled subagent result as a follow-up that triggers a parent turn. */
  readonly deliver: (message: SubagentResultMessage) => Effect.Effect<void>;
}

export class PiHost extends Context.Service<PiHost, PiHostShape>()("pi-subagents/v2/PiHost") {
  static readonly layer = (pi: ExtensionAPI): Layer.Layer<PiHost> =>
    Layer.succeed(PiHost, {
      sendMessage: (message, options) => {
        pi.sendMessage(message, options);
      },
      deliver: (message) =>
        Effect.sync(() => {
          pi.sendMessage(message.toOutbound(), { deliverAs: "followUp", triggerTurn: true });
        }),
    });
}

