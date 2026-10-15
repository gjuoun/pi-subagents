import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type SubagentResultDetails, SubagentResultMessage } from "../src/domain/subagent-result.js";
import { ResultMessageView } from "../src/ui/result-message-view.js";

const details = (over: Partial<SubagentResultDetails> = {}): SubagentResultDetails => ({
  id: "id",
  name: "general-purpose",
  type: "general-purpose",
  status: "done",
  description: "the task",
  durationMs: 2000,
  toolUses: 3,
  ...over,
});

const ANSWER = Array.from({ length: 40 }, (_, i) => `answer line ${i + 1}`).join("\n");

const message = (d: SubagentResultDetails | undefined, content: string) =>
  SubagentResultMessage.fromPlain({ details: d, content });

const render = (m: SubagentResultMessage, options: { expanded: boolean; width: number }) =>
  ResultMessageView.render(m, options);

describe("SubagentResultMessage.render", () => {
  it("collapsed renders exactly 5 lines with the hidden count last", () => {
    const lines = render(message(details(), ANSWER), { expanded: false, width: 60 });
    expect(lines).toHaveLength(5);
    // 40 body lines, 3 shown: 37 hidden (v1 counted 36, off by one).
    expect(lines[lines.length - 1]).toBe("… 37 more lines");
  });

  it("expanded renders the status line plus every body line", () => {
    const lines = render(message(details(), ANSWER), { expanded: true, width: 60 });
    expect(lines).toHaveLength(41);
  });

  it("keeps every line within the width", () => {
    const collapsed = render(message(details({ description: "x".repeat(300) }), ANSWER), { expanded: false, width: 60 });
    const expanded = render(message(details({ description: "x".repeat(300) }), "y".repeat(300)), { expanded: true, width: 60 });
    for (const line of [...collapsed, ...expanded]) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("renders the unified row without cost", () => {
    const d = details({ name: "scout", model: "zai/glm-5.3-flash", thinking: "high", tokens: 42_000, contextPercent: 9, turns: 3, toolUses: 2, durationMs: 1200 });
    expect(render(message(d, "ok"), { expanded: false, width: 200 })[0]).toBe("✅1s scout  the task  42k 9%");
  });

  it("lists one row per agent of a grouped message", () => {
    const a = SubagentResultMessage.fromPlain({ details: details({ id: "a", name: "a-agent" }), content: "A" });
    const b = SubagentResultMessage.fromPlain({ details: details({ id: "b", name: "b-agent" }), content: "B" });
    const lines = render(SubagentResultMessage.group([a, b], false), { expanded: false, width: 200 });
    expect(lines[0]).toContain("a-agent");
    expect(lines[1]).toContain("b-agent");
  });

  it("marks an error status with ❌", () => {
    expect(render(message(details({ status: "error" }), "boom"), { expanded: false, width: 60 })[0]).toContain("❌");
  });
});
