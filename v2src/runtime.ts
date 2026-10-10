import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  AgentRegistry,
  type AgentRegistryOptions,
  layer as agentRegistryLayer,
} from "./agent-registry.js";
import { PiHost, layer as piHostLayer } from "./pi-host.js";

/**
 * runtime.ts — the single composition root: one ManagedRuntime per extension instance.
 *
 * Inside v2src everything is an Effect; PiHost (pi-host.ts) is the thin, promise-free wrapper
 * over the pi handle so the rest of the code never touches ExtensionAPI directly. makeRuntime()
 * builds the layer graph; index.ts disposes it on session_shutdown.
 */

export type AppRuntime = ManagedRuntime.ManagedRuntime<AgentRegistry | PiHost, never>;

export interface RuntimeOptions extends AgentRegistryOptions {}

export const makeRuntime = (pi: ExtensionAPI, options: RuntimeOptions = {}): AppRuntime => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(agentRegistryLayer(options), piHostLayer(pi)));
  // Effect layers are lazy: nothing is acquired until an effect that needs them runs, so a
  // never-used runtime would dispose without running any finalizer. Touch both services once
  // at load so the graph is constructed now and dispose() always tears it down.
  void runtime.runPromise(warmup).catch(() => {});
  return runtime;
};

/** Forces the layer graph (and thus both service scopes) to be built. */
const warmup = Effect.gen(function* () {
  yield* AgentRegistry;
  yield* PiHost;
});
