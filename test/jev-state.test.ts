/**
 * jev-state.test.ts — roster criteria + state assembly for the `jev` tool.
 *
 * DI via parameters (types/describe/routingRules), so the suite never touches
 * the real `~/.pi/agent/agents` or the skills repo.
 */
import { describe, expect, it } from "vitest";
import { buildJevState, buildRosterCriteria, SITUATION_DEFAULT } from "../src/tools/jev-state.js";

describe("buildRosterCriteria", () => {
  it("maps enabled types to name → description criteria", () => {
    const criteria = buildRosterCriteria(
      ["worker", "finder", "vision"],
      (t) => ({ worker: "implements tasks with TDD", finder: "searches the codebase", vision: "describes images" })[t],
    );
    expect(criteria).toEqual({
      worker: "implements tasks with TDD",
      finder: "searches the codebase",
      vision: "describes images",
    });
  });

  it("drops types with an empty or missing description", () => {
    const criteria = buildRosterCriteria(["worker", "finder"], (t) => (t === "finder" ? "" : undefined));
    expect(criteria).toEqual({});
  });
});

describe("buildJevState", () => {
  it("assembles TASK + situation + routing rules", () => {
    const state = buildJevState("build a parser", "the repo is green", "Rule: workers implement.");
    expect(state).toContain("TASK:\nbuild a parser");
    expect(state).toContain("CURRENT SITUATION:\nthe repo is green");
    expect(state).toContain("ROUTING RULES:\nRule: workers implement.");
  });

  it("uses the default situation paragraph when no context is given", () => {
    expect(buildJevState("task", undefined, "rules")).toContain(`CURRENT SITUATION:\n${SITUATION_DEFAULT}`);
  });

  it("omits the ROUTING RULES section when none is available", () => {
    const state = buildJevState("task", undefined, null);
    expect(state).not.toContain("ROUTING RULES:");
  });
});
