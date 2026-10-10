import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import {
  Registry,
  type RegistryOptions,
  type RegistryShape,
  layer as registryLayer,
} from "./registry.js";

/**
 * runtime.ts — the single composition root: one ManagedRuntime per extension instance.
 *
 * Inside v2src everything is an Effect; PiHost is the thin, promise-free wrapper over the
 * pi handle so the rest of the code never touches ExtensionAPI directly. makeRuntime()
 * builds the layer graph; index.ts disposes it on session_shutdown.
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
}

export const PiHost = Context.Service<PiHostShape>("pi-subagents/v2/PiHost");

const piHostLayer = (pi: ExtensionAPI): Layer.Layer<PiHostShape> =>
  Layer.succeed(PiHost, {
    sendMessage: (message, options) => {
      pi.sendMessage(message, options);
    },
  });

export type AppRuntime = ManagedRuntime.ManagedRuntime<RegistryShape | PiHostShape, never>;

export interface RuntimeOptions extends RegistryOptions {}

export const makeRuntime = (pi: ExtensionAPI, options: RuntimeOptions = {}): AppRuntime => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(registryLayer(options), piHostLayer(pi)));
  // Effect layers are lazy: nothing is acquired until an effect that needs them runs, so a
  // never-used runtime would dispose without running any finalizer. Touch both services once
  // at load so the graph is constructed now and dispose() always tears it down.
  void runtime.runPromise(warmup).catch(() => {});
  return runtime;
};

/** Forces the layer graph (and thus both service scopes) to be built. */
const warmup = Effect.gen(function* () {
  yield* Registry;
  yield* PiHost;
});
