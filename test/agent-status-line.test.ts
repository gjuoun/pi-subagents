import { describe, expect, it } from "vitest";
import { formatAgentStatusLine } from "../src/ui/agent-status-line.js";

const amber = () => "#FFC800";
const cyan = () => "#00C8FF";
const uncolored = () => undefined;
const byType = (colors: Record<string, string>) => (type: string | undefined) =>
  (type ? colors[type] : undefined);

const agent = (type: string, status: "running" | "queued" | "completed") => ({ id: `${type}-${status}`, type, status });

describe("formatAgentStatusLine", () => {
  it("renders one filled mark per running agent, in order, in that type’s colour", () => {
    const line = formatAgentStatusLine(
      [agent("finder", "running"), agent("worker", "running")],
      0,
      byType({ finder: amber(), worker: cyan() }),
    );
    expect(line).toBe("\u001b[38;2;255;200;0m●\u001b[39m\u001b[38;2;0;200;255m●\u001b[39m");
  });

  it("blinks a running mark by intensity, never by glyph", () => {
    const bright = formatAgentStatusLine([agent("finder", "running")], 0, amber);
    const dim = formatAgentStatusLine([agent("finder", "running")], 1, amber);
    expect(bright).toContain("●");
    expect(dim).toContain("●");
    expect(dim).not.toBe(bright);
    expect(dim).toBe("\u001b[38;2;89;70;0m●\u001b[39m");
  });

  it("renders a queued agent as a hollow coloured circle that does not blink", () => {
    const queued = agent("finder", "queued");
    expect(formatAgentStatusLine([queued], 0, amber)).toBe("\u001b[38;2;255;200;0m○\u001b[39m");
    expect(formatAgentStatusLine([queued], 1, amber)).toBe(formatAgentStatusLine([queued], 0, amber));
  });

  it("keeps a finished agent solid — filled mark, no blink", () => {
    const done = agent("finder", "completed");
    const bright = formatAgentStatusLine([done], 0, amber);
    expect(bright).toBe("\u001b[38;2;255;200;0m●\u001b[39m");
    expect(formatAgentStatusLine([done], 1, amber)).toBe(bright);
  });

  it("falls back to an uncoloured mark when the type has no colour configured", () => {
    expect(formatAgentStatusLine([agent("plain", "running")], 0, uncolored)).toBe("●");
    expect(formatAgentStatusLine([agent("plain", "queued")], 0, uncolored)).toBe("○");
  });

  it("is empty when there is nothing to show", () => {
    expect(formatAgentStatusLine([], 0, amber)).toBe("");
  });
});
