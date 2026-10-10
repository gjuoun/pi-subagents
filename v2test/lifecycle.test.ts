import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makePi, ctx as mockCtx } from "../test/helpers/boot-extension.js";
import { GENERAL_PURPOSE } from "../v2src/domain/agent-type.js";
import { V2Extension } from "../v2src/index.js";
import { PiChildSession } from "../v2src/pi/pi-child-session.js";
import { AgentRegistry } from "../v2src/services/agent-registry.js";
import { stubSessionFactory, withParentContext } from "./helpers/stub-session-factory.js";

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

const child = (session: AgentSession, id: string) => new PiChildSession(session, id, "general-purpose");

describe("v2 lifecycle", () => {
  it("(a) session_shutdown aborts running children and disposes them all", async () => {
    const running = stubSession();
    const finished = stubSession();
    const { pi, lifecycle } = makePi();
    const ext = new V2Extension(pi, stubSessionFactory([child(running, "aaaaaaaa"), child(finished, "bbbbbbbb")]));
    ext.register();
    lifecycle.get("session_start")({}, mockCtx());
    const rt = ext.runtime;
    expect(rt).toBeDefined();
    await rt?.runPromise(
      withParentContext(
        Effect.gen(function* () {
          const registry = yield* AgentRegistry;
          yield* registry.create(GENERAL_PURPOSE, "d");
          const done = yield* registry.create(GENERAL_PURPOSE, "d");
          yield* done.run("x");
        }),
      ),
    );
    await lifecycle.get("session_shutdown")();
    expect(running.abort).toHaveBeenCalledTimes(1);
    expect(running.dispose).toHaveBeenCalledTimes(1);
    expect(finished.dispose).toHaveBeenCalledTimes(1);
    expect(finished.abort).not.toHaveBeenCalled();
  });

  it("(b) a known id is gone after shutdown + session_start", async () => {
    const { pi, lifecycle, tools } = makePi();
    const ext = new V2Extension(pi, stubSessionFactory(child(stubSession(), "cccccccc")));
    ext.register();
    lifecycle.get("session_start")({}, mockCtx());
    const id =
      (await ext.runtime?.runPromise(
        withParentContext(
          Effect.gen(function* () {
            const registry = yield* AgentRegistry;
            const agent = yield* registry.create(GENERAL_PURPOSE, "d");
            return agent.id;
          }),
        ),
      )) ?? "missing";
    await lifecycle.get("session_shutdown")();
    lifecycle.get("session_start")({}, mockCtx());
    const tool = tools.get("Agent");
    const result = await tool.execute(
      "call",
      { resume: id, prompt: "x", description: "d" },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(result.content[0].text).toMatch(/^Error \[AgentNotFound\]/);
  });

  it("(c) a run interrupted by shutdown sends no message", async () => {
    const hanging = stubSession(() => new Promise<void>(() => {}));
    const { pi, lifecycle } = makePi();
    const ext = new V2Extension(pi, stubSessionFactory(child(hanging, "dddddddd")));
    ext.register();
    lifecycle.get("session_start")({}, mockCtx());
    await ext.runtime?.runPromise(
      withParentContext(
        Effect.gen(function* () {
          const registry = yield* AgentRegistry;
          const agent = yield* registry.create(GENERAL_PURPOSE, "d");
          yield* registry.runInBackground(agent, "x");
        }),
      ),
    );
    await lifecycle.get("session_shutdown")();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
