import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ResultNotifierLive } from "./pi/pi-result-notifier.js";
import { SessionFactoryLive } from "./pi/pi-session-factory.js";
import { AgentRegistry } from "./services/agent-registry.js";
import { AgentTypeCatalog } from "./services/agent-type-catalog.js";
import { E2EHandle } from "./services/e2e-handle.js";
import { IdGenerator } from "./services/id-generator.js";

/**
 * layers.ts — the single composition root: one ManagedRuntime per extension instance.
 *
 * AppLayer(pi) is the whole graph; SessionFactory and ResultNotifier (both under pi/) are the
 * only pi-touching leaves, so nothing else imports ExtensionAPI. makeRuntime merges an optional
 * overrides layer over the defaults so a test swaps SessionFactory or IdGenerator in one place.
 */

export type AppRuntime = ManagedRuntime.ManagedRuntime<AgentRegistry | AgentTypeCatalog | E2EHandle, never>;

/** A layer a test merges over the defaults (SessionFactory, IdGenerator, …); the override wins. */
export type AppOverrides = Layer.Layer<never>;

/** The full layer graph. `overrides` is merged over the defaults before the registry builds. */
export const AppLayer = (
  pi: ExtensionAPI,
  overrides?: AppOverrides,
): Layer.Layer<AgentRegistry | AgentTypeCatalog | E2EHandle> => {
  const defaults = Layer.mergeAll(ResultNotifierLive(pi), SessionFactoryLive, IdGenerator.random);
  const deps = overrides === undefined ? defaults : Layer.merge(defaults, overrides);
  const registry = Layer.effect(AgentRegistry, AgentRegistry.make).pipe(Layer.provide(deps));
  const catalog = Layer.effect(AgentTypeCatalog, AgentTypeCatalog.make);
  return Layer.mergeAll(registry, E2EHandle.layer.pipe(Layer.provide(registry)), catalog);
};

export const makeRuntime = (pi: ExtensionAPI, overrides?: AppOverrides): AppRuntime => {
  const runtime = ManagedRuntime.make(AppLayer(pi, overrides));
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
