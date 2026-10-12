import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, agentToolResults, runV2, type V2Run } from "./helpers/v2-runner.js";

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const H = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as
    | { list(): Array<{ id: string; status: string }> }
    | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";

const isParent = (ctx: Context) => (ctx.tools ?? []).some((t) => t.name === "Agent");
const agentResultsOf = (ctx: Context) =>
  ctx.messages.filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");

function customContents(session: AgentSession): string[] {
  return session.messages
    .filter((m) => (m as { role?: string; customType?: string }).role === "custom")
    .filter((m) => (m as { customType?: string }).customType === "subagent-result")
    .map((m) => textOf(m as { content?: unknown }));
}

function childEntries(sessionDir: string): Array<Array<Record<string, unknown>>> {
  const out: Array<Array<Record<string, unknown>>> = [];
  for (const file of readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(sessionDir, file), "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]) as { parentSession?: string };
    if (header.parentSession) out.push(lines.map((l) => JSON.parse(l) as Record<string, unknown>));
  }
  return out;
}

describe("v2 resume", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("(a)+(c) continues the child session and returns the new answer inline", async () => {
    let childCalls = 0;
    let secondChildContext = "";
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) => {
        if (!isParent(ctx)) {
          childCalls += 1;
          if (childCalls === 2) secondChildContext = ctx.messages.map(textOf).join("\n");
          return childCalls === 1 ? "FIRST-ANSWER" : "SECOND-RUN-3";
        }
        const results = agentResultsOf(ctx);
        if (results.length === 0) return agentCall({ prompt: "FIRST-PROMPT", description: "first" });
        if (results.length === 1) {
          const id = H()?.list()[0]?.id;
          return agentCall({ prompt: "SECOND-PROMPT", description: "second", resume: id });
        }
        return "PARENT-DONE";
      },
    });
    expect(secondChildContext).toContain("FIRST-PROMPT");
    expect(secondChildContext).toContain("FIRST-ANSWER");
    expect(agentToolResults(run.parentSession)).toEqual(["FIRST-ANSWER", "SECOND-RUN-3"]);
  });

  it("(b) reuses the one child session file, growing it", async () => {
    let childCalls = 0;
    run = await runV2({
      prompt: "delegate",
      persist: true,
      respond: (ctx) => {
        if (!isParent(ctx)) {
          childCalls += 1;
          return childCalls === 1 ? "FIRST-ANSWER" : "SECOND-RUN-3";
        }
        const results = agentResultsOf(ctx);
        if (results.length === 0) return agentCall({ prompt: "FIRST-PROMPT", description: "first" });
        if (results.length === 1) {
          const id = H()?.list()[0]?.id;
          return agentCall({ prompt: "SECOND-PROMPT", description: "second", resume: id });
        }
        return "PARENT-DONE";
      },
    });
    const children = childEntries(run.sessionDir as string);
    expect(children).toHaveLength(1);
    const blob = JSON.stringify(children[0]);
    expect(blob).toContain("FIRST-ANSWER");
    expect(blob).toContain("SECOND-RUN-3");
  });

  it("(c-bg) a background resume arrives as a second subagent-result", async () => {
    let childCalls = 0;
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) => {
        if (!isParent(ctx)) {
          childCalls += 1;
          return childCalls === 1 ? "FIRST-ANSWER" : "SECOND-RUN-3";
        }
        const results = agentResultsOf(ctx);
        if (results.length === 0) {
          return agentCall({ prompt: "FIRST-PROMPT", description: "first", run_in_background: true });
        }
        if (results.length === 1) {
          const id = H()?.list()[0]?.id;
          return agentCall({ prompt: "SECOND-PROMPT", description: "second", resume: id, run_in_background: true });
        }
        return "PARENT-DONE";
      },
    });
    const entries = customContents(run.parentSession);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toContain("SECOND-RUN-3");
  });

  it("(d) rejects resuming a running agent and an unknown id", async () => {
    // Unknown id.
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) =>
        isParent(ctx)
          ? agentCall({ prompt: "x", description: "x", resume: "deadbeef" })
          : "CHILD",
    });
    expect(agentToolResults(run.parentSession)[0]).toMatch(/^Error \[AgentNotFound\]/);
    await run.dispose();
    run = undefined;

    // Busy: resume while the background child is still running.
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) => {
        if (!isParent(ctx)) {
          return sleep(500).then(() => "SLOW-ANSWER");
        }
        const results = agentResultsOf(ctx);
        if (results.length === 0) return agentCall({ prompt: "slow", description: "slow", run_in_background: true });
        if (results.length === 1) {
          const id = H()?.list()[0]?.id;
          return agentCall({ prompt: "again", description: "again", resume: id });
        }
        return "PARENT-DONE";
      },
    });
    expect(agentToolResults(run.parentSession).some((t) => t.startsWith("Error [AgentBusy]"))).toBe(true);
  });
});
