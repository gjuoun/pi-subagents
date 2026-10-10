import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, agentToolResults, routeBySession, runV2, type V2Run } from "./helpers/v2-runner.js";

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as
    | { list(): Array<{ id: string; status: string }> }
    | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function childLines(sessionDir: string): Array<Record<string, unknown>> | undefined {
  for (const file of readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(sessionDir, file), "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]) as { parentSession?: string };
    if (header.parentSession) return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  return undefined;
}

describe("v2 foreground Agent", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("(a) returns the child's answer inline as the Agent tool result", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "child task", description: "child" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-ANSWER-7",
      }),
    });
    expect(agentToolResults(run.parentSession)).toEqual(["CHILD-ANSWER-7"]);
  });

  it("(b) writes a child session whose header links the parent and is named <type>#<id8>", async () => {
    run = await runV2({
      prompt: "delegate",
      persist: true,
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "child task", description: "child" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD-ANSWER-7",
      }),
    });
    const lines = childLines(run.sessionDir as string);
    expect(lines).toBeDefined();
    expect((lines?.[0] as { parentSession?: string }).parentSession).toBe(run.parentSessionFile);
    const info = lines?.find((e) => e.type === "session_info") as { name?: string } | undefined;
    expect(info?.name).toMatch(/^general-purpose#[0-9a-f]{8}$/);
  });

  it("(c) gives the child no Agent tool", async () => {
    let childTools: string[] = [];
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "child task", description: "child" }),
        parentFinal: "PARENT-FINAL",
        subagent: (ctx) => {
          childTools = (ctx.tools ?? []).map((t) => t.name);
          return "CHILD-ANSWER-7";
        },
      }),
    });
    expect(childTools.length).toBeGreaterThan(0);
    expect(childTools).not.toContain("Agent");
  });

  it("(d) marks the run aborted and reports it when the parent turn is aborted mid-child", async () => {
    let session: { abort(): void } | undefined;
    run = await runV2({
      prompt: "delegate",
      persist: true,
      onReady: (s) => {
        session = s;
      },
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "child task", description: "child" }),
        parentFinal: "PARENT-FINAL",
        subagent: async () => {
          await sleep(40);
          session?.abort();
          await sleep(40);
          return "CHILD-ANSWER-7";
        },
      }),
    });
    expect(agentToolResults(run.parentSession)[0]).toContain("was aborted");
    expect(handle()?.list().some((r) => r.status === "aborted")).toBe(true);
  });

  it("(e) surfaces a failed final turn as Error [RunFailed]", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "child task", description: "child" }),
        parentFinal: "PARENT-FINAL",
        subagent: fauxAssistantMessage([], { stopReason: "error" }),
      }),
    });
    expect(agentToolResults(run.parentSession)[0]).toMatch(/^Error \[RunFailed\]/);
  });
});
