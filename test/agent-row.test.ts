import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../src/domain/agent.js";
import { formatAgentRow, formatIdentity, formatModel, formatTokens, formatUsage } from "../src/ui/agent-row.js";
import { agentCallLine, agentResultLines } from "../src/ui/agent-tool-view.js";

/** agent-row.test.ts — the shared agent identity line and the Agent tool row (JW-166 Step 13). */

const snap = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: "abcd1234",
  type: "scout",
  name: "scout",
  handle: "scout",
  description: "slow scan",
  status: "done",
  runs: 1,
  startedAt: 1_000,
  finishedAt: 2_200,
  lastText: "ANSWER",
  toolUses: 2,
  turns: 3,
  wrappedUp: false,
  model: "glm-5.3-flash",
  thinking: "high",
  tokens: 42_000,
  contextPercent: 9.4,
  ...over,
});

describe("agent row formatting", () => {
  it("formats tokens", () => {
    expect([formatTokens(980), formatTokens(1_500), formatTokens(42_000), formatTokens(2_100_000)]).toEqual([
      "980",
      "1.5k",
      "42k",
      "2.1M",
    ]);
  });

  it("formats model - thinking, stripping a provider", () => {
    expect(formatModel("zai-coding-cn/glm-5.3-flash", "high")).toBe("glm-5.3-flash - high");
    expect(formatModel("glm-5.3-flash", undefined)).toBe("glm-5.3-flash");
    expect(formatModel(undefined, undefined)).toBe("");
  });

  it("formats usage without cost", () => {
    expect(formatUsage(42_000, 9.4)).toBe("42k 9%");
    expect(formatUsage(0, undefined)).toBe("");
  });

  it("renders <agent> <model - thinking> <tokens ctx%>", () => {
    expect(formatIdentity(snap())).toBe("scout  glm-5.3-flash - high  42k 9%");
  });

  it("renders the Agent tool row", () => {
    expect(formatAgentRow(snap(), 5_000)).toBe("✓ scout  glm-5.3-flash - high  42k 9% · 3 turns · 2 tool uses · 1.2s");
    expect(formatAgentRow(snap({ status: "running", finishedAt: undefined, turns: 1, toolUses: 0, tokens: 0, contextPercent: undefined }), 3_500)).toBe(
      "⠋ scout  glm-5.3-flash - high · 1 turn · 2.5s",
    );
  });

  it("renders the call line and the collapsed result", () => {
    expect(agentCallLine({ subagent_type: "scout", description: "slow scan" })).toBe("▸ scout  slow scan");
    expect(agentResultLines("first\nsecond", snap(), false, 5_000)).toEqual([
      "✓ scout  glm-5.3-flash - high  42k 9% · 3 turns · 2 tool uses · 1.2s",
      "⎿  first",
    ]);
    expect(agentResultLines("first\nsecond", undefined, true, 0)).toEqual(["first", "second"]);
  });
});
