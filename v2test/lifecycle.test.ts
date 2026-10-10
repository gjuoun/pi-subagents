import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makePi, ctx as mockCtx } from "../test/helpers/boot-extension.js";
import { V2Extension } from "../v2src/index.js";
import { ChildSession } from "../v2src/pi/pi-child-session.js";
import { AgentRegistry } from "../v2src/services/agent-registry.js";

type StubSession = AgentSession & { abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };

function stubSession(prompt?: () => Promise<void>): StubSession {
  return {
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    messages: [],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(prompt ?? (async () => {})),
  } as unknown as StubSession;
}

const child = (session: AgentSession, id: string) => new ChildSession(session, id, "general-purpose");

describe("v2 lifecycle", () => {
  it("(a) session_shutdown aborts running children and disposes them all", async () => {
    const { pi, lifecycle } = makePi();
    const ext = new V2Extension(pi);
    ext.register();
    lifecycle.get("session_start")({}, mockCtx());
    const rt = ext.runtime;
    expect(rt).toBeDefined();
    const running = stubSession();
    const finished = stubSession();
    await rt?.runPromise(
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        yield* registry.adopt(child(running, "aaaaaaaa"), "general-purpose", "d");
        const done = yield* registry.adopt(child(finished, "bbbbbbbb"), "general-purpose", "d");
        yield* done.run("x");
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
    const ext = new V2Extension(pi);
    ext.register();
    lifecycle.get("session_start")({}, mockCtx());
    await ext.runtime?.runPromise(
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        yield* registry.adopt(child(stubSession(), "cccccccc"), "general-purpose", "d");
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
    const ext = new V2Extension(pi);
    ext.register();
    lifecycle.get("session_start")({}, mockCtx());
    const hanging = stubSession(() => new Promise<void>(() => {}));
    await ext.runtime?.runPromise(
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        const agent = yield* registry.adopt(child(hanging, "dddddddd"), "general-purpose", "d");
        yield* registry.runInBackground(agent, "x");
      }),
    );
    await lifecycle.get("session_shutdown")();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
