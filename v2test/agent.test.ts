import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../v2src/agent-registry.js";
import { ChildSession } from "../v2src/child-session.js";
import { AgentBusy } from "../v2src/errors.js";
import { makeRuntime } from "../v2src/runtime.js";

const fakePi = () => ({ sendMessage: vi.fn() }) as unknown as ExtensionAPI;

/** A stub session whose prompt blocks until release() is called. */
function gatedSession() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = {
    messages: [],
    subscribe: () => () => {},
    prompt: async () => {
      await gate;
    },
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
  return { session, release };
}

describe("Agent busy guard", () => {
  it("lets exactly one of two concurrent runs proceed", async () => {
    const rt = makeRuntime(fakePi());
    try {
      const { session, release } = gatedSession();
      const agent = await rt.runPromise(
        Effect.gen(function* () {
          const registry = yield* AgentRegistry;
          return yield* registry.adopt(
            new ChildSession(session, "eeeeeeee", "general-purpose"),
            "general-purpose",
            "d",
          );
        }),
      );

      const settled = await rt.runPromise(
        Effect.gen(function* () {
          const a = yield* Effect.forkChild(Effect.result(agent.run("one")));
          const b = yield* Effect.forkChild(Effect.result(agent.run("two")));
          yield* Effect.sync(() => release());
          return [yield* Fiber.join(a), yield* Fiber.join(b)] as const;
        }),
      );

      const failure = settled.find((r) => Result.isFailure(r));
      const winner = settled.find((r) => Result.isSuccess(r));
      expect(failure !== undefined && Result.isFailure(failure) ? failure.failure : undefined).toBeInstanceOf(
        AgentBusy,
      );
      expect(winner !== undefined && Result.isSuccess(winner) ? winner.success : undefined).toBe("");
      expect(await rt.runPromise(agent.isRunning)).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});
