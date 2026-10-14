import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, isParentCall, runV2, toolResultsNamed, type V2Run } from "./helpers/v2-runner.js";

/** steer.test.ts — steer_subagent (JW-166 Step 11). */

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";
const startedId = (ctx: Context): string => {
  const started = ctx.messages.find((m) => m.role === "toolResult" && textOf(m).startsWith("Started"));
  return /id ([0-9a-f]{8})/.exec(started ? textOf(started) : "")?.[1] ?? "missing";
};
const notifications = (session: AgentSession) =>
  session.messages
    .filter((m) => (m as { customType?: string }).customType === "subagent-result")
    .map((m) => textOf(m as { content?: unknown }));

describe("v2 steer_subagent", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("injects the message into a running child and changes its next reply", async () => {
    let parentCalls = 0;
    run = await runV2({
      prompt: "delegate",
      respond: async (ctx) => {
        if (!isParentCall(ctx)) {
          const steered = ctx.messages.some((m) => m.role === "user" && textOf(m).includes("STEER-MSG-9"));
          if (steered) return "STEERED-REPLY";
          if (ctx.messages.some((m) => m.role === "toolResult")) return "UNSTEERED-REPLY";
          await new Promise((r) => setTimeout(r, 300));
          return fauxToolCall("read", { path: "slow.txt" });
        }
        parentCalls += 1;
        if (parentCalls === 1) return agentCall({ prompt: "work", description: "slow", run_in_background: true });
        if (parentCalls === 2) return fauxToolCall("steer_subagent", { agent_id: startedId(ctx), message: "STEER-MSG-9" });
        return "PARENT-FINAL";
      },
    });
    expect(toolResultsNamed(run.parentSession, "steer_subagent")[0]).toMatch(/^Steering message sent/);
    expect(notifications(run.parentSession).join("\n")).toContain("STEERED-REPLY");
  });

  it("refuses to steer a settled agent", async () => {
    let parentCalls = 0;
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) => {
        if (!isParentCall(ctx)) return "DONE";
        parentCalls += 1;
        if (parentCalls === 1) return agentCall({ prompt: "t", description: "quick", name: "quick-one" });
        if (parentCalls === 2) return fauxToolCall("steer_subagent", { agent_id: "quick-one", message: "late" });
        return "PARENT-FINAL";
      },
    });
    expect(toolResultsNamed(run.parentSession, "steer_subagent")[0]).toMatch(/^Error \[NotRunning\].*is not running/);
  });
});
