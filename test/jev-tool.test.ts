/**
 * jev-tool.test.ts — the `jev` tool's execute seam with a stubbed classifier.
 * No network: askJev is module-mocked, roster is fixed, env keys are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/tools/jev/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/jev/client.js")>("../src/tools/jev/client.js");
  return { ...actual, askJev: vi.fn() };
});
vi.mock("../src/tools/jev/state.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/jev/state.js")>("../src/tools/jev/state.js");
  return {
    ...actual,
    buildRosterCriteria: vi.fn(() => ({ worker: "implements tasks with TDD", finder: "searches the codebase" })),
  };
});

import { askJev } from "../src/tools/jev/client.js";
import { createJevTool } from "../src/tools/jev/index.js";
import { buildRosterCriteria } from "../src/tools/jev/state.js";

const tool = createJevTool(undefined);
const textOf = (r: any): string => r.content[0].text;

const OK = {
  ok: true,
  choice: "worker",
  probabilities: { worker: 0.68, finder: 0.15, expert: 0.1 },
  confidence: 0.64,
  inputTokens: 2087,
  outputTokens: 116,
  costUsd: 0.000087654,
  ms: 300,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("jev tool", () => {
  beforeEach(() => {
    vi.stubEnv("JEV_API_KEY", "sk-test");
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");
  });

  it("returns the decision: winner, distribution, confidence, cost", async () => {
    vi.mocked(askJev).mockResolvedValue(OK as any);
    const out = textOf(await tool.execute("tc", { task: "build a parser" }, undefined, undefined, undefined as any));
    expect(out).toContain("winner: worker");
    expect(out).toContain("worker 68%, finder 15%, expert 10%");
    expect(out).toContain("confidence: 0.64");
    expect(out).toContain("cost: $0.000088");
    expect(out).not.toContain("escalate");
  });

  it("flags escalate when the winner confidence is below conf_min", async () => {
    vi.mocked(askJev).mockResolvedValue(OK as any);
    const out = textOf(await tool.execute("tc", { task: "t", conf_min: 0.7 }, undefined, undefined, undefined as any));
    expect(out).toContain("escalate:");
  });

  it("passes an ok:false classifier failure through as a visible result", async () => {
    vi.mocked(askJev).mockResolvedValue({ ok: false, error: "network failure calling the classifier", remedy: "dispatch using your own judgment" } as any);
    const out = textOf(await tool.execute("tc", { task: "t" }, undefined, undefined, undefined as any));
    expect(out).toContain("jev unavailable: network failure");
  });

  it("fails open without a key", async () => {
    vi.stubEnv("JEV_API_KEY", "");
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");
    const out = textOf(await tool.execute("tc", { task: "t" }, undefined, undefined, undefined as any));
    expect(out).toContain("no classifier key");
    expect(askJev).not.toHaveBeenCalled();
  });

  it("fails open when the roster has no describable types", async () => {
    vi.mocked(buildRosterCriteria).mockReturnValue({});
    const out = textOf(await tool.execute("tc", { task: "t" }, undefined, undefined, undefined as any));
    expect(out).toContain("no describable agent types");
    expect(askJev).not.toHaveBeenCalled();
  });
});
