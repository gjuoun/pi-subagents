/**
 * settings-jev-enabled.test.ts — the `jevEnabled` master switch, asserted at
 * the setting/context seam: default off (the tool costs an API call per use,
 * so it is opt-in), applySettings wiring both directions, and the
 * snapshotSettings read half (a key missing there is erased from the user's
 * subagents.json on the next unrelated toggle — which is what
 * `_NoMissingSettingsKeys` guards at compile time).
 */
import { describe, expect, it, vi } from "vitest";
import { applySettings, type SettingsAppliers, type SubagentsSettings } from "../src/config/settings.js";
import { ActivationContext } from "../src/extension/context.js";
import { ModelScope } from "../src/model/model-scope.js";
import type { AgentsUiDeps } from "../src/ui/agents/deps.js";
import { snapshotSettings } from "../src/ui/agents/settings-overlay.js";

function makeAppliers(): SettingsAppliers {
  return {
    setMaxConcurrent: vi.fn(),
    setMaxConcurrentForeground: vi.fn(),
    setDefaultMaxTurns: vi.fn(),
    setGraceTurns: vi.fn(),
    setDefaultJoinMode: vi.fn(),
    setBackgroundByDefault: vi.fn(),
    setSchedulingEnabled: vi.fn(),
    setScopeModels: vi.fn(),
    setStrictAgentFiles: vi.fn(),
    setDisableDefaultAgents: vi.fn(),
    setToolDescriptionMode: vi.fn(),
    setFleetView: vi.fn(),
    setAgentMentions: vi.fn(),
    setRememberAgents: vi.fn(),
    setWidgetMode: vi.fn(),
    setOutputTranscript: vi.fn(),
    setWorktreeIsolation: vi.fn(),
    setWorkflowsEnabled: vi.fn(),
    setJevEnabled: vi.fn(),
    setMaxSubagentDepth: vi.fn(),
    setFallbackSubagent: vi.fn(),
    setReportUsage: vi.fn(),
    setShowCost: vi.fn(),
    setShowModel: vi.fn(),
    setViewerMarkdown: vi.fn(),
  };
}

/** Minimal deps for snapshotSettings — real context, one stub for the un-assigned manager. */
function makeDeps(context: ActivationContext): AgentsUiDeps {
  return {
    pi: { events: { emit: vi.fn() } } as unknown as AgentsUiDeps["pi"],
    context: Object.assign(context, {
      manager: { getMaxConcurrent: () => 10, getMaxConcurrentForeground: () => 0 },
      modelScope: new ModelScope(),
    }) as unknown as AgentsUiDeps["context"],
    reloadCustomAgents: vi.fn(),
  } as unknown as AgentsUiDeps;
}

describe("jevEnabled", () => {
  it("defaults to off — the tool is opt-in, it costs an API call per use", () => {
    const context = new ActivationContext();
    expect(context.isJevEnabled()).toBe(false);
  });

  it("applySettings wires the persisted value to the applier, both directions", () => {
    const appliers = makeAppliers();
    applySettings({ jevEnabled: true } as SubagentsSettings, appliers);
    expect(appliers.setJevEnabled).toHaveBeenCalledWith(true);

    vi.mocked(appliers.setJevEnabled).mockClear();
    applySettings({ jevEnabled: false } as SubagentsSettings, appliers);
    expect(appliers.setJevEnabled).toHaveBeenCalledWith(false);
  });

  it("applySettings ignores an absent jevEnabled", () => {
    const appliers = makeAppliers();
    applySettings({} as SubagentsSettings, appliers);
    expect(appliers.setJevEnabled).not.toHaveBeenCalled();
  });

  it("snapshotSettings round-trips the context value (missing here erases it from subagents.json)", () => {
    const context = new ActivationContext();
    expect(snapshotSettings(makeDeps(context)).jevEnabled).toBe(false);

    context.setJevEnabled(true);
    expect(snapshotSettings(makeDeps(context)).jevEnabled).toBe(true);
  });
});
