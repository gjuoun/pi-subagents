import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../src/domain/agent.js";
import { formatElapsed } from "../src/domain/agent.js";
import { formatAgentRow, formatModel, formatTokens, statusIcon } from "../src/ui/agent-row.js";
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
  it("draws one icon table for every surface", () => {
    expect(["running", "done", "error", "aborted", "queued"].map(statusIcon)).toEqual(["⏳", "✅", "❌", "🛑", "🕒"]);
    expect(statusIcon("something-else")).toBe("⏳");
  });

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

  it("renders the one row, with the model only on request", () => {
    expect(formatAgentRow(snap(), 5_000)).toBe("✅1s scout  slow scan  42k 9%");
    expect(formatAgentRow(snap(), 5_000, { model: true })).toBe("✅1s scout  slow scan  glm-5.3-flash - high  42k 9%");
    expect(formatAgentRow(snap(), 5_000, { model: true, description: false })).toBe("✅1s scout  glm-5.3-flash - high  42k 9%");
    expect(formatAgentRow(snap({ status: "running", finishedAt: undefined, tokens: 0, contextPercent: undefined }), 3_500)).toBe("⏳3s scout  slow scan");
  });

  it("writes the clock as a duration", () => {
    expect([formatElapsed(11_000), formatElapsed(100_000), formatElapsed(3_720_000)]).toEqual(["11s", "1m40s", "1h2m"]);
  });

  it("hands every piece to the painter, in order", () => {
    const parts: string[] = [];
    const line = formatAgentRow(snap(), 5_000, {
      marker: "●",
      model: true,
      paint: (part, text) => {
        parts.push(part);
        return text;
      },
    });
    expect(line).toBe("●✅1s scout  slow scan  glm-5.3-flash - high  42k 9%");
    expect(parts).toEqual(["marker", "icon", "clock", "name", "description", "model", "tokens", "ctx"]);
  });

  it("renders the call line and the collapsed result", () => {
    expect(agentCallLine({ subagent_type: "scout", description: "slow scan" })).toBe("▸ scout  slow scan");
    expect(agentResultLines("first\nsecond", snap(), false, 5_000)).toEqual([
      "✅1s scout  slow scan  42k 9%",
      "⎿  first",
    ]);
    expect(agentResultLines("first\nsecond", undefined, true, 0)).toEqual(["first", "second"]);
  });
});
