import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ResultNotifierLive } from "./pi/pi-result-notifier.js";
import { SessionFactoryLive } from "./pi/pi-session-factory.js";
import { AgentRegistry } from "./services/agent-registry.js";
import { AgentTypeCatalog } from "./services/agent-type-catalog.js";
import { E2EHandle } from "./services/e2e-handle.js";
import { IdGenerator } from "./services/id-generator.js";
import type { SessionFactory } from "./services/session-factory.js";

/**
 * layers.ts — the single composition root: one ManagedRuntime per extension instance.
 *
 * Inside v2src everything is an Effect; SessionFactory (pi/pi-session-factory.ts) and
 * ResultNotifier (pi/pi-result-notifier.ts) are the only pi-touching leaves, so the rest of the
 * code never touches ExtensionAPI directly. makeRuntime() builds the layer graph; index.ts
 * disposes it on session_shutdown.
 */

export type AppRuntime = ManagedRuntime.ManagedRuntime<AgentRegistry | AgentTypeCatalog | E2EHandle, never>;

export const makeRuntime = (
  pi: ExtensionAPI,
  sessionFactory: Layer.Layer<SessionFactory> = SessionFactoryLive,
): AppRuntime => {
  const deps = Layer.mergeAll(ResultNotifierLive(pi), sessionFactory, IdGenerator.random);
  const registry = Layer.effect(AgentRegistry, AgentRegistry.make).pipe(Layer.provide(deps));
  const catalog = Layer.effect(AgentTypeCatalog, AgentTypeCatalog.make);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(registry, E2EHandle.layer.pipe(Layer.provide(registry)), catalog),
  );
  // Effect layers are lazy: nothing is acquired until an effect that needs them runs, so a
  // never-used runtime would dispose without running any finalizer. Touch the graph once at
  // load so it is constructed now and dispose() always tears it down.
  void runtime.runPromise(warmup).catch(() => {});
  return runtime;
};

/** Forces the layer graph (and thus every service scope) to be built. */
const warmup = Effect.gen(function* () {
  yield* AgentRegistry;
  yield* AgentTypeCatalog;
  yield* E2EHandle;
});
