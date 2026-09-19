/**
 * settings-jev-enabled.test.ts — the `jevEnabled` master switch, asserted at
 * the setting/context seam: default off (the tool costs an API call per use,
 * so it is opt-in), applySettings wiring both directions, and the
 * snapshotSettings read half (a key missing there is erased from the user's
 * subagents.json on the next unrelated toggle — which is what
 * `_NoMissingSettingsKeys` guards at compile time).
 */
import { describe, expect, it, vi } from "vitest";
import { applySettings, type SettingsSurface, type SettingsTarget, type SubagentsSettings } from "../src/config/settings.js";
import { ActivationContext } from "../src/extension/context.js";
import { ModelScope } from "../src/model/model-scope.js";
import type { AgentsUiDeps } from "../src/ui/agents/deps.js";
import { snapshotSettings } from "../src/ui/agents/settings-overlay.js";

/** A target whose context is a plain object, so every write is observable. */
function makeTarget(): { context: SettingsSurface; services: SettingsTarget["services"]; target: SettingsTarget } {
  // The two handles a setting drives live on the services object, not the context.
  const services = {
    manager: { setMaxConcurrent: vi.fn(), setMaxConcurrentForeground: vi.fn() },
    modelScope: { setEnabled: vi.fn() },
  };
  const context = {
    strictAgentFiles: false,
    defaultJoinMode: "smart",
    backgroundByDefault: true,
    schedulingEnabled: true,
    toolDescriptionMode: "full",
    fleetViewEnabled: true,
    agentMentionMode: "model",
    widgetMode: "background",
    reportUsage: false,
    showCost: false,
    showModel: false,
    viewerMarkdown: "all",
    workflowsEnabled: true,
    jevEnabled: false,
    setReportUsage: vi.fn(),
    setShowCost: vi.fn(),
    setShowModel: vi.fn(),
    setWidgetMode: vi.fn(),
    setFleetViewEnabled: vi.fn(),
    setWorkflowsEnabled: vi.fn(),
  } satisfies SettingsSurface;
  const target: SettingsTarget = {
    services,
    context,
    setDefaultMaxTurns: vi.fn(),
    setGraceTurns: vi.fn(),
    setMaxSubagentDepth: vi.fn(),
    setFallbackSubagent: vi.fn(),
    setDisableDefaultAgents: vi.fn(),
    setRememberAgents: vi.fn(),
    setOutputTranscript: vi.fn(),
    setWorktreeIsolation: vi.fn(),
  };
  return { context, services, target };
}

/** Minimal deps for snapshotSettings — a real context plus the two handles it reads. */
function makeDeps(context: ActivationContext): AgentsUiDeps {
  return {
    pi: { events: { emit: vi.fn() } } as unknown as AgentsUiDeps["pi"],
    services: {
      manager: { getMaxConcurrent: () => 10, getMaxConcurrentForeground: () => 0 },
      modelScope: new ModelScope(),
    } as unknown as AgentsUiDeps["services"],
    context: context as unknown as AgentsUiDeps["context"],
    reloadCustomAgents: vi.fn(),
  } as unknown as AgentsUiDeps;
}

describe("jevEnabled", () => {
  it("defaults to off — the tool is opt-in, it costs an API call per use", () => {
    const context = new ActivationContext();
    expect(context.jevEnabled).toBe(false);
  });

  it("applySettings wires the persisted value to the context, both directions", () => {
    const { context, target } = makeTarget();
    applySettings({ jevEnabled: true } as SubagentsSettings, target);
    expect(context.jevEnabled).toBe(true);

    applySettings({ jevEnabled: false } as SubagentsSettings, target);
    expect(context.jevEnabled).toBe(false);
  });

  it("applySettings ignores an absent jevEnabled", () => {
    const { context, target } = makeTarget();
    context.jevEnabled = true;
    applySettings({} as SubagentsSettings, target);
    expect(context.jevEnabled).toBe(true);
  });

  it("snapshotSettings round-trips the context value (missing here erases it from subagents.json)", () => {
    const context = new ActivationContext();
    expect(snapshotSettings(makeDeps(context)).jevEnabled).toBe(false);

    context.jevEnabled = true;
    expect(snapshotSettings(makeDeps(context)).jevEnabled).toBe(true);
  });
});
