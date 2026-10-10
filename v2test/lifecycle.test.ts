import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect, FiberMap } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makePi, ctx as mockCtx } from "../test/helpers/boot-extension.js";
import { createV2Extension } from "../v2src/index.js";
import { type AgentRecord, Registry } from "../v2src/registry.js";

const record = (id: string, status: AgentRecord["status"] = "running"): AgentRecord => ({
  id,
  type: "general-purpose",
  name: "general-purpose",
  description: "d",
  status,
  runs: 0,
  startedAt: Date.now(),
  lastText: "",
  toolUses: 0,
});

function stubSession(): AgentSession & { abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return {
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    messages: [],
    subscribe: vi.fn(() => () => {}),
  } as unknown as AgentSession & { abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
}

describe("v2 lifecycle", () => {
  it("(a) session_shutdown aborts running children and disposes them all", async () => {
    const { pi, lifecycle } = makePi();
    const ext = createV2Extension(pi);
    lifecycle.get("session_start")({}, mockCtx());
    const rt = ext.getRuntime();
    expect(rt).toBeDefined();
    const running = stubSession();
    const finished = stubSession();
    await rt?.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry;
        yield* registry.putRecord(record("aaaaaaaa", "running"));
        yield* registry.putRecord(record("bbbbbbbb", "done"));
        yield* registry.putEntry("aaaaaaaa", { session: running });
        yield* registry.putEntry("bbbbbbbb", { session: finished });
      }),
    );
    await lifecycle.get("session_shutdown")();
    expect(running.abort).toHaveBeenCalledTimes(1);
    expect(running.dispose).toHaveBeenCalledTimes(1);
    expect(finished.dispose).toHaveBeenCalledTimes(1);
    expect(finished.abort).not.toHaveBeenCalled();
  });

  it("(b) a known id is gone after shutdown + session_start", async () => {
    const { pi, lifecycle, tools } = makePi();
    const ext = createV2Extension(pi);
    lifecycle.get("session_start")({}, mockCtx());
    await ext.getRuntime()?.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry;
        yield* registry.putRecord(record("cccccccc", "done"));
        yield* registry.putEntry("cccccccc", { session: stubSession() });
      }),
    );
    await lifecycle.get("session_shutdown")();
    lifecycle.get("session_start")({}, mockCtx());
    const tool = tools.get("Agent");
    const result = await tool.execute(
      "call",
      { resume: "cccccccc", prompt: "x", description: "d" },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(result.content[0].text).toMatch(/^Error \[AgentNotFound\]/);
  });

  it("(c) a run interrupted by shutdown sends no message", async () => {
    const { pi, lifecycle } = makePi();
    const ext = createV2Extension(pi);
    lifecycle.get("session_start")({}, mockCtx());
    await ext.getRuntime()?.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry;
        yield* registry.putRecord(record("dddddddd", "running"));
        yield* registry.putEntry("dddddddd", { session: stubSession() });
        yield* FiberMap.run(registry.fibers, "dddddddd", Effect.never);
      }),
    );
    await lifecycle.get("session_shutdown")();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
