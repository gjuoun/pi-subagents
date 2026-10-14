import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, agentToolResults, DEFAULT_TEST_AGENT, routeBySession, runV2, type V2Run } from "./helpers/v2-runner.js";

/**
 * agent-params.test.ts — the Agent tool's decided parameter surface (JW-166 Step 3):
 * background by default, exact model resolution with a typed error, a required
 * subagent_type, and a caller-chosen name.
 */

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as
    | { list(): Array<{ id: string; name: string; status: string }> }
    | undefined;

describe("v2 Agent tool parameters", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("runs in the background when run_in_background is omitted", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: fauxToolCall("Agent", { subagent_type: DEFAULT_TEST_AGENT, prompt: "t", description: "d" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-DONE",
      }),
    });
    expect(agentToolResults(run.parentSession)[0]).toMatch(/^Started worker \(id [0-9a-f]{8}\) in the background/);
  });

  it("fails an unknown model with Error [UnknownModel] instead of falling back", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "t", description: "d", model: "nope/none" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-DONE",
      }),
    });
    const text = agentToolResults(run.parentSession)[0];
    expect(text).toMatch(/^Error \[UnknownModel\]/);
    expect(text).toContain("nope/none");
    expect(text).toContain("worker");
  });

  it("accepts an exact provider/id model", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "t", description: "d", model: "faux/faux-1" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-ANSWER-8",
      }),
    });
    expect(agentToolResults(run.parentSession)).toEqual(["CHILD-ANSWER-8"]);
  });

  it("rejects a call without subagent_type", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: fauxToolCall("Agent", { prompt: "t", description: "d", run_in_background: false }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-DONE",
      }),
    });
    const text = agentToolResults(run.parentSession)[0];
    expect(text).toMatch(/subagent_type/);
    expect(handle()?.list() ?? []).toHaveLength(0);
  });

  it("names the agent from the name parameter", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "t", description: "d", name: "auth-audit" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-DONE",
      }),
    });
    expect(handle()?.list().map((a) => a.name)).toEqual(["auth-audit"]);
  });
});
