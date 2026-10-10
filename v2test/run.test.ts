import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runTool } from "../v2src/boundary.js";
import { type AgentRecord, Registry } from "../v2src/registry.js";
import { runOnce } from "../v2src/run.js";
import { makeRuntime } from "../v2src/runtime.js";

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as { hasRunning(): boolean } | undefined;

const fakePi = () => ({ sendMessage: vi.fn() }) as unknown as ExtensionAPI;

const record = (id: string): AgentRecord => ({
  id,
  type: "general-purpose",
  name: "general-purpose",
  description: "d",
  status: "running",
  runs: 0,
  startedAt: Date.now(),
  lastText: "",
  toolUses: 0,
});

function rejectingSession(): AgentSession {
  return {
    messages: [],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(() => Promise.reject(new Error("boom"))),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

describe("runOnce failure path", () => {
  it("marks a rejected prompt as error, not running forever", async () => {
    const rt = makeRuntime(fakePi());
    try {
      const session = rejectingSession();
      const id = "eeeeeeee";
      await rt.runPromise(
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* registry.putRecord(record(id));
          yield* registry.putEntry(id, { session });
        }),
      );

      const result = await runTool(rt, runOnce(id, session, "do it"), undefined);
      expect((result.content[0] as { text?: string }).text).toMatch(/^Error \[RunFailed\]/);

      const stored = await rt.runPromise(
        Effect.gen(function* () {
          const registry = yield* Registry;
          return yield* registry.get(id);
        }),
      );
      expect(stored.status).toBe("error");
      expect(stored.finishedAt).toBeTypeOf("number");
      expect(stored.runs).toBe(1);
      expect(handle()?.hasRunning()).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});
