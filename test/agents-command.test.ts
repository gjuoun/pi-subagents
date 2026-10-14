import { describe, expect, it, vi } from "vitest";
import v2Extension from "../src/index.js";
import { AGENTS_COMMAND, describeType } from "../src/pi/agents-command.js";
import { hermeticDir, makePi, ctx as mockCtx } from "./helpers/boot-extension.js";

/** agents-command.test.ts — /agents (JW-166 Step 16). */

describe("v2 /agents", () => {
  it("is registered and lists Running agents and Agent types", async () => {
    const hermetic = hermeticDir({
      agentFiles: { scout: "---\nname: scout\ndescription: A scout\nmax_turns: 7\n---\nSCOUT" },
    });
    try {
      const { pi, commands, lifecycle } = makePi();
      v2Extension(pi);
      expect([...commands.keys()]).toEqual([AGENTS_COMMAND]);
      lifecycle.get("session_start")({}, mockCtx({ cwd: hermetic.dir }));
      const select = vi
        .fn()
        .mockResolvedValueOnce("Agent types (1)")
        .mockResolvedValueOnce("scout");
      const notify = vi.fn();
      await commands.get(AGENTS_COMMAND).handler("", mockCtx({ cwd: hermetic.dir, ui: { select, notify } }));
      expect(select.mock.calls[0]).toEqual(["Agents", ["Running agents (0)", "Agent types (1)"]]);
      expect(notify.mock.calls[0][0]).toContain("scout — A scout");
      expect(notify.mock.calls[0][0]).toContain("max_turns: 7");
      await lifecycle.get("session_shutdown")();
    } finally {
      hermetic.restore();
    }
  });

  it("describes a type without inventing values", () => {
    expect(describeType({ name: "x", description: "d", systemPrompt: "", skills: true, enabled: true })).toBe(
      "x — d\nmodel: inherit · thinking: inherit\ntools: all · max_turns: unlimited · skills: true\nsource: ?",
    );
  });
});
