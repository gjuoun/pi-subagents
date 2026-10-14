import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticDir } from "./helpers/boot-extension.js";
import { agentCall, agentToolResults, isParentCall, runV2, type V2Run } from "./helpers/v2-runner.js";

/**
 * turns.test.ts — max_turns with the scaled wrap-up (JW-166 Step 7). At the cap the child is
 * steered to wrap up; it gets max(10, ceil(cap * 0.25)) more turns, then a hard abort.
 */

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as
    | { list(): Array<{ status: string; turns: number; wrappedUp: boolean }> }
    | undefined;

const WRAP_UP = "You have reached your turn limit";
const scout = (maxTurns?: number) =>
  ["---", "name: scout", "description: A scout", "tools: read", ...(maxTurns ? [`max_turns: ${maxTurns}`] : []), "---", "SCOUT"].join("\n");

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";
const sawWrapUp = (ctx: Context) => ctx.messages.some((m) => m.role === "user" && textOf(m).includes(WRAP_UP));

describe("v2 max_turns + scaled wrap-up", () => {
  let run: V2Run | undefined;
  let hermetic: ReturnType<typeof hermeticDir> | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  /** Drive one foreground scout whose child replies come from `child(callIndex, ctx)`. */
  async function drive(maxTurns: number | undefined, child: (n: number, ctx: Context) => unknown) {
    hermetic = hermeticDir({ agentFiles: { scout: scout(maxTurns) } });
    let childCalls = 0;
    let parentSpawned = false;
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      maxModelCalls: 60,
      timeoutMs: 60_000,
      respond: (ctx) => {
        if (!isParentCall(ctx)) {
          childCalls += 1;
          return child(childCalls, ctx) as never;
        }
        if (parentSpawned) return "PARENT-FINAL";
        parentSpawned = true;
        return agentCall({ subagent_type: "scout", prompt: "loop", description: "loop" });
      },
    });
    return () => childCalls;
  }

  it("steers at the cap and hard-aborts after max(10, ceil(cap*0.25)) more turns", async () => {
    let firstWrapUpCall = 0;
    const calls = await drive(2, (n, ctx) => {
      if (firstWrapUpCall === 0 && sawWrapUp(ctx)) firstWrapUpCall = n;
      return fauxToolCall("read", { path: `missing-${n}.txt` });
    });
    expect(firstWrapUpCall).toBe(3);
    // The abort lands while turn 13's request is already in flight; that request is cut off,
    // so the run completes exactly 12 turns.
    expect(calls()).toBeLessThanOrEqual(13);
    const snap = handle()?.list()[0];
    expect(snap?.status).toBe("aborted");
    expect(snap?.turns).toBe(12);
    expect(agentToolResults(run!.parentSession)[0]).toContain("turn limit");
  });

  it("settles done with wrappedUp when the child answers inside the grace window", async () => {
    const calls = await drive(2, (n, ctx) => (sawWrapUp(ctx) ? "WRAPPED-ANSWER" : fauxToolCall("read", { path: `m${n}` })));
    expect(calls()).toBe(3);
    expect(agentToolResults(run!.parentSession)[0]).toContain("WRAPPED-ANSWER");
    const snap = handle()?.list()[0];
    expect(snap?.status).toBe("done");
    expect(snap?.wrappedUp).toBe(true);
  });

  it("never steers without max_turns", async () => {
    let steered = false;
    const calls = await drive(undefined, (n, ctx) => {
      if (sawWrapUp(ctx)) steered = true;
      return n <= 30 ? fauxToolCall("read", { path: `m${n}` }) : "LONG-DONE";
    });
    expect(calls()).toBe(31);
    expect(steered).toBe(false);
    expect(agentToolResults(run!.parentSession)[0]).toContain("LONG-DONE");
  });
});
