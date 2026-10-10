import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type SubagentResultDetails, SubagentResultMessage } from "../v2src/domain/subagent-result.js";
import { ResultMessageView } from "../v2src/ui/result-message-view.js";

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
    expect(lines[lines.length - 1]).toBe("… 36 more lines");
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

  it("uses a ✗ for an error status", () => {
    expect(SubagentResultMessage.statusGlyph("error")).toBe("✗");
    expect(render(message(details({ status: "error" }), "boom"), { expanded: false, width: 60 })[0]).toContain("✗");
  });
});
