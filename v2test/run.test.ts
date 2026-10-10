import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { GENERAL_PURPOSE } from "../v2src/domain/agent-type.js";
import { makeRuntime } from "../v2src/layers.js";
import { runTool } from "../v2src/pi/boundary.js";
import { PiChildSession } from "../v2src/pi/pi-child-session.js";
import { AgentRegistry } from "../v2src/services/agent-registry.js";
import { stubSessionFactory, withParentContext } from "./helpers/stub-session-factory.js";

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as { hasRunning(): boolean } | undefined;

const fakePi = () => ({ sendMessage: vi.fn() }) as unknown as ExtensionAPI;

function rejectingSession(): AgentSession {
  return {
    messages: [],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(() => Promise.reject(new Error("boom"))),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

describe("Agent.run failure path", () => {
  it("marks a rejected prompt as error, not running forever", async () => {
    const child = new PiChildSession(rejectingSession(), "eeeeeeee", "general-purpose");
    const rt = makeRuntime(fakePi(), stubSessionFactory(child));
    try {
      const agent = await rt.runPromise(
        withParentContext(
          Effect.gen(function* () {
            const registry = yield* AgentRegistry;
            return yield* registry.create(GENERAL_PURPOSE, "d");
          }),
        ),
      );

      const result = await runTool(rt, agent.run("do it"), undefined);
      expect((result.content[0] as { text?: string }).text).toMatch(/^Error \[RunFailed\]/);

      const stored = await rt.runPromise(agent.snapshot);
      expect(stored.status).toBe("error");
      expect(stored.finishedAt).toBeTypeOf("number");
      expect(stored.runs).toBe(1);
      expect(handle()?.hasRunning()).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});
