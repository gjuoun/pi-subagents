import { Context, Effect, Layer } from "effect";
import type { AgentSnapshot } from "../domain/agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { GroupJoin } from "./group-join.js";

/**
 * e2e-handle.ts — the cross-package handle the e2e harness reads.
 *
 * Published on `Symbol.for("pi-subagents:v2")` when the layer is built and removed by its own
 * finalizer, so a disposed runtime leaves nothing behind.
 */

export const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");

export interface V2Handle {
  hasRunning(): boolean;
  waitForAll(): Promise<void>;
  list(): Array<AgentSnapshot>;
}

export class E2EHandle extends Context.Service<E2EHandle, V2Handle>()("pi-subagents/v2/E2EHandle") {
  static readonly layer: Layer.Layer<E2EHandle, never, AgentRegistry | GroupJoin> = Layer.effect(
    E2EHandle,
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const join = yield* GroupJoin;
      const handle: V2Handle = {
        // "Running" for the harness includes results still held by the smart join.
        hasRunning: () => registry.hasRunning() || join.pending(),
        waitForAll: async () => {
          while (handle.hasRunning()) await new Promise((resolve) => setTimeout(resolve, 10));
        },
        list: () => [...registry.list()],
      };
      (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] = handle;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if ((globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] === handle) {
            delete (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY];
          }
        }),
      );
      return handle;
    }),
  );
}
