import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { showAgentViewMenu } from "../src/ui/agent-view-menu.js";

/** Minimal deps: the menu reads the flag, the roster and the pi event bus. */
function makeDeps(on: boolean, agents = 0) {
  const setFleetViewEnabled = vi.fn();
  return {
    context: {
      isFleetViewEnabled: () => on,
      setFleetViewEnabled,
      manager: { listAgents: () => Array.from({ length: agents }, (_, i) => ({ id: `a${i}`, type: "finder", status: "running" })) },
    },
    pi: { events: { emit: vi.fn() } },
    setFleetViewEnabled,
  };
}

const noopPersist = () => ({ message: "saved", level: "info" as const });

describe("showAgentViewMenu", () => {
  it("offers the Agent view toggle carrying its current state", async () => {
    const select = vi.fn(async () => undefined);
    await showAgentViewMenu({ ui: { select, notify: vi.fn() } } as any, makeDeps(true) as any, noopPersist);
    expect(select).toHaveBeenCalledWith("Agent", expect.arrayContaining(["Agent view: on", "Done"]));
  });

  it("counts the agents it can list", async () => {
    const select = vi.fn(async () => undefined);
    await showAgentViewMenu({ ui: { select, notify: vi.fn() } } as any, makeDeps(true, 3) as any, noopPersist);
    expect(select).toHaveBeenCalledWith("Agent", expect.arrayContaining(["Running agents (3)"]));
  });

  it("flips the view, persists the new value, and re-opens on the new state", async () => {
    const deps = makeDeps(true);
    const select = vi.fn();
    select.mockResolvedValueOnce("Agent view: on").mockResolvedValueOnce("Done");
    const persist = vi.fn(() => ({ message: "Agent view off", level: "info" as const }));
    const notify = vi.fn();
    await showAgentViewMenu({ ui: { select, notify } } as any, deps as any, persist);
    expect(deps.setFleetViewEnabled).toHaveBeenCalledWith(false);
    expect(persist).toHaveBeenCalledWith(expect.anything(), false);
    expect(notify).toHaveBeenCalledWith("Agent view off", "info");
  });

  it("is registered by the extension as /agent", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/registerCommand\("agent", \{/);
  });
});
