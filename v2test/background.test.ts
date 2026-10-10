import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentCall,
  agentToolResults,
  invokedToolNames,
  routeBySession,
  runV2,
  type V2Run,
} from "./helpers/v2-runner.js";

interface CustomResult {
  content: string;
  details?: { id?: string; status?: string };
}

const BIG_REPLY = "X".repeat(3000 - "TAIL-MARKER-91".length) + "TAIL-MARKER-91";

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";

/** The subagent-result custom entries the parent session holds. */
function customEntries(session: AgentSession): CustomResult[] {
  return session.messages
    .filter((m) => (m as { role?: string; customType?: string }).role === "custom")
    .filter((m) => (m as { customType?: string }).customType === "subagent-result")
    .map((m) => ({
      content: textOf(m as { content?: unknown }),
      details: (m as { details?: CustomResult["details"] }).details,
    }));
}

/** Capture the full text the parent's model is shown on a spawned turn. */
function captureModelText(sink: string[]) {
  return (ctx: { messages: Array<{ content?: unknown }> }) => {
    sink.push(ctx.messages.map(textOf).join("\n"));
    return "PARENT-FINAL";
  };
}

describe("v2 background Agent", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("(a) returns a Started envelope before the child finishes", async () => {
    run = await runV2({
      prompt: "delegate in background",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "long task", description: "bg", run_in_background: true }),
        parentFinal: "PARENT-FINAL",
        subagent: BIG_REPLY,
      }),
    });
    expect(agentToolResults(run.parentSession)[0]).toMatch(
      /^Started general-purpose \(id [0-9a-f]{8}\) in the background/,
    );
  });

  it("(b) injects the full child answer (3,000 chars) into the parent's context", async () => {
    const modelText: string[] = [];
    run = await runV2({
      prompt: "delegate in background",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "long task", description: "bg", run_in_background: true }),
        parentFinal: captureModelText(modelText),
        subagent: BIG_REPLY,
      }),
    });
    const entries = customEntries(run.parentSession);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain(BIG_REPLY);
    expect(entries[0].details?.status).toBe("done");
    expect(modelText.join("\n")).toContain(BIG_REPLY);
  });

  it("(c) never has the parent call a tool other than Agent", async () => {
    run = await runV2({
      prompt: "delegate in background",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "long task", description: "bg", run_in_background: true }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-DONE",
      }),
    });
    const names = invokedToolNames(run.parentSession);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n === "Agent")).toBe(true);
  });

  it("(d) reports a failed child as a subagent-result with status error", async () => {
    run = await runV2({
      prompt: "delegate in background",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "task", description: "bad", run_in_background: true }),
        parentFinal: "PARENT-FINAL",
        subagent: fauxAssistantMessage([], { stopReason: "error" }),
      }),
    });
    const entries = customEntries(run.parentSession);
    expect(entries).toHaveLength(1);
    expect(entries[0].details?.status).toBe("error");
    expect(entries[0].content.length).toBeGreaterThan(0);
  });

  it("(e) delivers one message per concurrent background child", async () => {
    run = await runV2({
      prompt: "delegate two in background",
      respond: routeBySession({
        parentInitial: [
          agentCall({ prompt: "task a", description: "a", run_in_background: true }),
          agentCall({ prompt: "task b", description: "b", run_in_background: true }),
        ],
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-DONE",
      }),
    });
    const entries = customEntries(run.parentSession);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.details?.id)).size).toBe(2);
  });
});
