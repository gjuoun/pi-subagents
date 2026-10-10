import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { PiHost } from "./pi/pi-result-notifier.js";
import { SessionFactoryLive } from "./pi/pi-session-factory.js";
import { AgentRegistry, type AgentRegistryOptions } from "./services/agent-registry.js";
import type { SessionFactory } from "./services/session-factory.js";

/**
 * layers.ts — the single composition root: one ManagedRuntime per extension instance.
 *
 * Inside v2src everything is an Effect; SessionFactory (pi/pi-session-factory.ts) and PiHost
 * (pi/pi-result-notifier.ts) are the only pi-touching leaves, so the rest of the code never
 * touches ExtensionAPI directly. makeRuntime() builds the layer graph; index.ts disposes it on
 * session_shutdown.
 */

export type AppRuntime = ManagedRuntime.ManagedRuntime<AgentRegistry | PiHost, never>;

export interface RuntimeOptions extends AgentRegistryOptions {}

export const makeRuntime = (
  pi: ExtensionAPI,
  options: RuntimeOptions = {},
  sessionFactory: Layer.Layer<SessionFactory> = SessionFactoryLive,
): AppRuntime => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(AgentRegistry.layer(options).pipe(Layer.provide(sessionFactory)), PiHost.layer(pi)),
  );
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
