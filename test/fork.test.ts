import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FORK_PLACEHOLDER, FORK_REFUSAL } from "../src/domain/fork.js";
import { agentCall, agentToolResults, isParentCall, runV2, toolNamesOf, type V2Run } from "./helpers/v2-runner.js";

/** fork.test.ts — subagent_type "fork", the branched subagent (JW-166 Step 18). */

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";
const isForkCall = (ctx: Context) => ctx.messages.some((m) => m.role === "user" && textOf(m).includes("<fork_directive>"));
const forkCall = (prompt: string, extra: Record<string, unknown> = {}) =>
  agentCall({ subagent_type: "fork", prompt, description: "fork", ...extra });

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as { list(): Array<{ id: string; type: string }> } | undefined;

describe("v2 fork", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("continues the main conversation with a placeholder per tool call and the directive", async () => {
    let seen: Context | undefined;
    let parentDone = false;
    run = await runV2({
      prompt: "PARENT-SECRET-42 is the code. Delegate.",
      persist: true,
      respond: (ctx) => {
        if (isForkCall(ctx)) {
          seen = ctx;
          return "FORK-DONE";
        }
        if (parentDone || ctx.messages.some((m) => m.role === "toolResult")) return "PARENT-FINAL";
        parentDone = true;
        return [forkCall("report the code"), fauxToolCall("read", { path: "nothing-here.txt" })];
      },
    });
    expect(agentToolResults(run.parentSession)).toEqual(["FORK-DONE"]);
    const messages = seen?.messages ?? [];
    expect(messages.map(textOf).join("\n")).toContain("PARENT-SECRET-42");
    const placeholders = messages.filter((m) => m.role === "toolResult" && textOf(m) === FORK_PLACEHOLDER);
    expect(placeholders).toHaveLength(2);
    const directive = messages.filter((m) => m.role === "user").map(textOf).at(-1) ?? "";
    expect(directive).toContain("<fork_directive>");
    expect(directive).toContain("report the code");
  });

  it("is offered the parent's tools, Agent included", async () => {
    let forkTools: string[] = [];
    let parentTools: string[] = [];
    run = await runV2({
      prompt: "delegate",
      persist: true,
      respond: (ctx) => {
        if (isForkCall(ctx)) {
          forkTools = toolNamesOf(ctx);
          return "FORK-DONE";
        }
        if (ctx.messages.some((m) => m.role === "toolResult")) return "PARENT-FINAL";
        parentTools = toolNamesOf(ctx);
        return forkCall("look");
      },
    });
    expect(forkTools).toContain("Agent");
    expect([...forkTools].sort()).toEqual([...parentTools].sort());
  });

  it("writes a fork session file whose header links the parent", async () => {
    run = await runV2({
      prompt: "delegate",
      persist: true,
      respond: (ctx) => (isForkCall(ctx) ? "FORK-DONE" : ctx.messages.some((m) => m.role === "toolResult") ? "PARENT-FINAL" : forkCall("x")),
    });
    const dir = run.sessionDir as string;
    const forks = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>))
      .filter((lines) => lines.some((e) => e.type === "session_info" && String((e as { name?: string }).name).startsWith("fork#")));
    expect(forks).toHaveLength(1);
    expect((forks[0][0] as { parentSession?: string }).parentSession).toBe(run.parentSessionFile);
  });

  it("refuses the Agent tool inside a fork", async () => {
    run = await runV2({
      prompt: "delegate",
      persist: true,
      respond: (ctx) => {
        if (isForkCall(ctx)) {
          const refused = ctx.messages.some((m) => m.role === "toolResult" && textOf(m) === FORK_REFUSAL);
          return refused ? "REFUSED-OK" : fauxToolCall("Agent", { subagent_type: "worker", prompt: "x", description: "x" });
        }
        return ctx.messages.some((m) => m.role === "toolResult") ? "PARENT-FINAL" : forkCall("try to delegate");
      },
    });
    expect(agentToolResults(run.parentSession)).toEqual(["REFUSED-OK"]);
  });

  it("fails without a parent session file", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: (ctx) =>
        isParentCall(ctx) && !ctx.messages.some((m) => m.role === "toolResult") ? forkCall("x") : "PARENT-FINAL",
    });
    expect(agentToolResults(run.parentSession)[0]).toMatch(/^Error \[ForkUnavailable\]/);
  });

  it("resumes a fork with its own history", async () => {
    let parentCalls = 0;
    let secondRunSawFirst = false;
    run = await runV2({
      prompt: "delegate",
      persist: true,
      respond: (ctx) => {
        if (isForkCall(ctx)) {
          const users = ctx.messages.filter((m) => m.role === "user").map(textOf);
          if (users.at(-1) === "second directive") {
            secondRunSawFirst = ctx.messages.some((m) => m.role === "assistant" && textOf(m) === "FORK-1");
            return "FORK-2";
          }
          return "FORK-1";
        }
        parentCalls += 1;
        if (parentCalls === 1) return forkCall("first directive");
        if (parentCalls === 2) {
          const id = handle()?.list().find((a) => a.type === "fork")?.id ?? "missing";
          return agentCall({ resume: id, prompt: "second directive", description: "again" });
        }
        return "PARENT-FINAL";
      },
    });
    expect(agentToolResults(run.parentSession)).toEqual(["FORK-1", "FORK-2"]);
    expect(secondRunSawFirst).toBe(true);
  });
});
