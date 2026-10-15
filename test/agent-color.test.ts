import { describe, expect, it } from "vitest";
import { agentBadge, agentFrame, badgeTextColor, resolveAgentColor } from "../src/ui/agent-color.js";

/** agent-color.test.ts — badge colours (JW-166 Step 16). */

describe("v2 agent color", () => {
  it("accepts hex (quoted or not) and the eight Claude Code names", () => {
    expect(resolveAgentColor('"#f59e0b"')).toBe("#F59E0B");
    expect(resolveAgentColor("#9ED3DC")).toBe("#9ED3DC");
    expect(resolveAgentColor("purple")).toBe("#827DBD");
    for (const name of ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]) {
      expect(resolveAgentColor(name)).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("rejects the dropped Agency aliases and junk", () => {
    expect(resolveAgentColor("amber")).toBeUndefined();
    expect(resolveAgentColor("teal")).toBeUndefined();
    expect(resolveAgentColor("#12345")).toBeUndefined();
    expect(resolveAgentColor(undefined)).toBeUndefined();
  });

  it("picks the more contrasting badge text", () => {
    expect(badgeTextColor("#FEFD99")).toBe("black");
    expect(badgeTextColor("#1E3A8A")).toBe("white");
  });

  it("renders a truecolor badge, or nothing for an invalid colour", () => {
    expect(agentBadge("finder", "#FEFD99")).toBe("\x1b[48;2;254;253;153;30m finder \x1b[0m");
    expect(agentBadge("finder", "nope")).toBeUndefined();
  });

  it("frames in the agent colour as a foreground, resetting only the foreground", () => {
    expect(agentFrame("╭─╮", "#FEFD99")).toBe("\x1b[38;2;254;253;153m╭─╮\x1b[39m");
  });
});
