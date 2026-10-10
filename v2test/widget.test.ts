import type { AgentSession, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type AgentSnapshot } from "../v2src/agent.js";
import { AgentRegistry } from "../v2src/agent-registry.js";
import { ChildSession } from "../v2src/child-session.js";
import { makeRuntime } from "../v2src/runtime.js";
import { AgentWidget, WIDGET_KEY } from "../v2src/ui/agent-widget.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rec = (over: Partial<AgentSnapshot>): AgentSnapshot => ({
  id: "x",
  type: "general-purpose",
  name: "general-purpose",
  description: "d",
  status: "running",
  runs: 0,
  startedAt: 0,
  lastText: "",
  toolUses: 0,
  ...over,
});

function stubSession(): AgentSession {
  return {
    messages: [],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
}

describe("AgentWidget.render", () => {
  it("lists running agents then recently finished ones, in order", () => {
    const now = 10_000;
    const records = [
      rec({ id: "a", name: "agent-a", startedAt: 1000 }),
      rec({ id: "b", name: "agent-b", startedAt: 2000 }),
      rec({ id: "c", name: "agent-c", status: "done", finishedAt: now - 2000 }),
    ];
    const lines = AgentWidget.render(records, now, 50);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("agent-a");
    expect(lines[1]).toContain("agent-b");
    expect(lines[2]).toContain("agent-c");
  });

  it("omits an agent finished more than 5s ago", () => {
    const now = 10_000;
    const records = [
      rec({ id: "a", name: "agent-a", startedAt: 9000 }),
      rec({ id: "c", name: "agent-c", status: "done", finishedAt: now - 6000 }),
    ];
    const lines = AgentWidget.render(records, now, 50);
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.includes("agent-c"))).toBe(false);
  });

  it("caps at 5 rows and appends +N more", () => {
    const records = Array.from({ length: 7 }, (_, i) => rec({ id: `${i}`, name: `agent-${i}`, startedAt: i }));
    const lines = AgentWidget.render(records, 100_000, 50);
    expect(lines).toHaveLength(6);
    expect(lines[lines.length - 1]).toBe("+2 more");
  });

  it("keeps every line within the width", () => {
    const records = Array.from({ length: 7 }, (_, i) =>
      rec({ id: `${i}`, name: `agent-${i}`, description: "x".repeat(200), lastTool: "very-long-tool-name" }),
    );
    for (const line of AgentWidget.render(records, 100_000, 50)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(50);
    }
  });
});

describe("AgentWidget wiring", () => {
  const fakePi = () => ({ sendMessage: vi.fn() }) as unknown as ExtensionAPI;

  it("removes the widget when there are no records", async () => {
    const rt = makeRuntime(fakePi());
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as ExtensionUIContext;
    try {
      rt.runFork(new AgentWidget(ui).run);
      await sleep(30);
      expect(setWidget).toHaveBeenCalledWith(WIDGET_KEY, undefined);
    } finally {
      await rt.dispose();
    }
  });

  it("stops repainting once the runtime is disposed", async () => {
    const rt = makeRuntime(fakePi());
    const tui = { requestRender: vi.fn() };
    const setWidget = vi.fn((_key: string, content: unknown) => {
      if (typeof content === "function") (content as (t: unknown, th: unknown) => void)(tui, {});
    });
    const ui = { setWidget } as unknown as ExtensionUIContext;
    rt.runFork(new AgentWidget(ui).run);
    await rt.runPromise(
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        yield* registry.adopt(new ChildSession(stubSession(), "a", "general-purpose"), "general-purpose", "d");
      }),
    );
    await sleep(1300); // let a 1s tick request a paint
    const before = tui.requestRender.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    await rt.dispose();
    await sleep(1300);
    expect(tui.requestRender.mock.calls.length).toBe(before);
  });
});
