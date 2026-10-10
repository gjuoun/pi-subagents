import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type SubagentResultDetails, SubagentResultMessage, statusGlyph } from "../v2src/subagent-result-message.js";

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
  SubagentResultMessage.fromPi({ details: d, content });

describe("SubagentResultMessage.render", () => {
  it("collapsed renders exactly 5 lines with the hidden count last", () => {
    const lines = message(details(), ANSWER).render({ expanded: false, width: 60 });
    expect(lines).toHaveLength(5);
    expect(lines[lines.length - 1]).toBe("… 36 more lines");
  });

  it("expanded renders the status line plus every body line", () => {
    const lines = message(details(), ANSWER).render({ expanded: true, width: 60 });
    expect(lines).toHaveLength(41);
  });

  it("keeps every line within the width", () => {
    const collapsed = message(details({ description: "x".repeat(300) }), ANSWER).render({ expanded: false, width: 60 });
    const expanded = message(details({ description: "x".repeat(300) }), "y".repeat(300)).render({ expanded: true, width: 60 });
    for (const line of [...collapsed, ...expanded]) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("uses a ✗ for an error status", () => {
    expect(statusGlyph("error")).toBe("✗");
    expect(message(details({ status: "error" }), "boom").render({ expanded: false, width: 60 })[0]).toContain("✗");
  });
});
