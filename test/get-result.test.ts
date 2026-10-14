import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, isParentCall, runV2, toolResultsNamed, type V2Run } from "./helpers/v2-runner.js";

/** get-result.test.ts — handles and get_subagent_result (JW-166 Step 10). */

const results = (session: AgentSession) => toolResultsNamed(session, "get_subagent_result");
const notifications = (session: AgentSession) =>
  session.messages.filter((m) => (m as { customType?: string }).customType === "subagent-result");
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

describe("v2 get_subagent_result", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("reads a background result by id with wait, and by handle", async () => {
    let calls = 0;
    run = await runV2({
      prompt: "delegate",
      respond: async (ctx) => {
        if (!isParentCall(ctx)) {
          await new Promise((r) => setTimeout(r, 150));
          return "CHILD-ANSWER-55";
        }
        calls += 1;
        if (calls === 1) return agentCall({ prompt: "t", description: "audit", name: "Auth Audit", run_in_background: true });
        if (calls === 2) return fauxToolCall("get_subagent_result", { agent_id: startedId(ctx), wait: true });
        if (calls === 3) return fauxToolCall("get_subagent_result", { agent_id: "auth-audit" });
        return "PARENT-FINAL";
      },
    });
    const [byId, byHandle] = results(run.parentSession);
    expect(byId).toContain("Status: done");
    expect(byId).toContain("CHILD-ANSWER-55");
    expect(byHandle).toContain("(auth-audit)");
    expect(byHandle).toContain("CHILD-ANSWER-55");
  });

  it("includes the child's tool calls with verbose", async () => {
    let calls = 0;
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) => {
        if (!isParentCall(ctx)) {
          return ctx.messages.some((m) => m.role === "toolResult")
            ? "CHILD-READ-DONE"
            : fauxToolCall("read", { path: "nothing-here.txt" });
        }
        calls += 1;
        if (calls === 1) return agentCall({ prompt: "t", description: "reader", run_in_background: true });
        if (calls === 2) return fauxToolCall("get_subagent_result", { agent_id: startedId(ctx), wait: true, verbose: true });
        return "PARENT-FINAL";
      },
    });
    const [report] = results(run.parentSession);
    expect(report).toContain("--- Agent Conversation ---");
    expect(report).toContain("[Tool Call]: read");
  });

  it("does not deliver a completion message for a result already read", async () => {
    let calls = 0;
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) => {
        if (!isParentCall(ctx)) return "CHILD-QUICK";
        calls += 1;
        if (calls === 1) return agentCall({ prompt: "t", description: "quick", run_in_background: true });
        if (calls === 2) return fauxToolCall("get_subagent_result", { agent_id: startedId(ctx), wait: true });
        return "PARENT-FINAL";
      },
    });
    expect(results(run.parentSession)[0]).toContain("CHILD-QUICK");
    expect(notifications(run.parentSession)).toHaveLength(0);
  });

  it("reports an unknown agent", async () => {
    let calls = 0;
    run = await runV2({
      prompt: "ask",
      respond: (ctx) => {
        if (!isParentCall(ctx)) return "X";
        calls += 1;
        return calls === 1 ? fauxToolCall("get_subagent_result", { agent_id: "nobody" }) : "PARENT-FINAL";
      },
    });
    expect(results(run.parentSession)[0]).toMatch(/^Error \[AgentNotFound\]/);
  });
});
