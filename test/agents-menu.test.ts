/**
 * agents-menu.test.ts — the `/agents` root menu as the ONE way into the Agent View.
 *
 * The separate `/agent` command is gone (agent-view-tui Step 4): the toggle lives on the root
 * screen as a row, so seeing the view never needs a keypress first, and it persists through the
 * Settings overlay's own save path — the file, not a second kind of state.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelScope } from "../src/model/model-scope.js";
import { showAgentsMenu } from "../src/ui/agents/menu.js";

/** The whole context slice `snapshotSettings` reads, so a flip can really be persisted. */
function makeDeps(on: boolean) {
  const state = { on };
  return {
    state,
    context: {
      modelScope: new ModelScope(),
      manager: { listAgents: () => [], getMaxConcurrent: () => 10, getMaxConcurrentForeground: () => 0 },
      scheduler: { isActive: () => false, list: () => [] },
      workflowTasks: new Map(),
      strictAgentFiles: false,
      setFleetViewEnabled: vi.fn((b: boolean) => { state.on = b; }),
      get fleetViewEnabled() { return state.on; },
      workflowsEnabled: false,
      workflowsPinned: false,
      schedulingEnabled: false,
      jevEnabled: false,
      reportUsage: false,
      showCost: false,
      showModel: false,
      defaultJoinMode: "smart",
      backgroundByDefault: true,
      toolDescriptionMode: "full",
      agentMentionMode: "model",
      widgetMode: "background",
      viewerMarkdown: "assistant",
    },
    pi: { events: { emit: vi.fn() } },
    reloadCustomAgents: () => {},
    setDisableDefaultAgents: () => {},
  };
}

/** The workflow submenu is built in index.ts; the root menu only forwards it. */
const workflowDeps = () => ({ tasks: new Map(), getRecord: () => undefined, viewAgentConversation: vi.fn(), getCtx: () => undefined });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("/agents root menu", () => {
  it("carries the Agent view toggle as its own row", async () => {
    const select = vi.fn(async () => undefined);
    await showAgentsMenu({ ui: { select, notify: vi.fn() } } as any, makeDeps(true) as any, workflowDeps() as any);
    expect(select).toHaveBeenCalledWith("Agents", expect.arrayContaining(["Agent view: on"]));
  });

  it("shows the state it is in when the view is off", async () => {
    const select = vi.fn(async () => undefined);
    await showAgentsMenu({ ui: { select, notify: vi.fn() } } as any, makeDeps(false) as any, workflowDeps() as any);
    expect(select).toHaveBeenCalledWith("Agents", expect.arrayContaining(["Agent view: off"]));
  });

  it("flips the view, writes fleetView to the settings file, and re-opens on the new state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-agents-menu-"));
    dirs.push(dir);
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const deps = makeDeps(true);
      const select = vi.fn();
      select.mockResolvedValueOnce("Agent view: on").mockResolvedValueOnce(undefined);
      const notify = vi.fn();
      await showAgentsMenu({ ui: { select, notify } } as any, deps as any, workflowDeps() as any);

      expect(deps.context.setFleetViewEnabled).toHaveBeenCalledWith(false);
      const written = JSON.parse(readFileSync(join(dir, ".pi", "subagents.json"), "utf-8"));
      expect(written.fleetView).toBe(false);
      expect(deps.pi.events.emit).toHaveBeenCalledWith(
        "subagents:settings_changed",
        expect.objectContaining({ persisted: true, settings: expect.objectContaining({ fleetView: false }) }),
      );
      expect(notify).toHaveBeenCalledWith("Agent view off", "info");
      // Re-opened with the state the flip produced — the same "call me again" shape as Back.
      expect(select).toHaveBeenLastCalledWith("Agents", expect.arrayContaining(["Agent view: off"]));
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("is the only way in: no separate /agent command is registered", async () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/registerCommand\("agents", \{/);
    expect(source).not.toMatch(/registerCommand\("agent", \{/);
  });
});
