import type { Context } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticDir } from "./helpers/boot-extension.js";
import { agentCall, isParentCall, runV2, type V2Run } from "./helpers/v2-runner.js";

/**
 * queue.test.ts — the background pool (JW-166 Step 8): with maxConcurrent 1 a second
 * background spawn waits as `queued` and starts when the first settles.
 */

const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");
const handle = () =>
  (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as
    | { list(): Array<{ description: string; status: string }> }
    | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";

function resultOrder(session: AgentSession): string[] {
  return session.messages
    .filter((m) => (m as { customType?: string }).customType === "subagent-result")
    .map((m) => ((m as { details?: { description?: string } }).details?.description ?? ""));
}

describe("v2 background pool", () => {
  let run: V2Run | undefined;
  let hermetic: ReturnType<typeof hermeticDir> | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  it("queues a second background agent until the first settles", async () => {
    hermetic = hermeticDir({ settings: { maxConcurrent: 1 } });
    let parentCalls = 0;
    let statusesWhileBusy: Record<string, string> = {};
    const startOrder: string[] = [];
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      timeoutMs: 30_000,
      respond: async (ctx: Context) => {
        if (!isParentCall(ctx)) {
          const task = ctx.messages.map(textOf).join("\n").includes("TASK-A") ? "A" : "B";
          startOrder.push(task);
          if (task === "A") await sleep(300);
          return `${task}-DONE`;
        }
        parentCalls += 1;
        if (parentCalls === 1) return agentCall({ prompt: "TASK-A", description: "first", run_in_background: true });
        if (parentCalls === 2) return agentCall({ prompt: "TASK-B", description: "second", run_in_background: true });
        if (parentCalls === 3) {
          statusesWhileBusy = Object.fromEntries((handle()?.list() ?? []).map((a) => [a.description, a.status]));
        }
        return "PARENT-FINAL";
      },
    });
    expect(statusesWhileBusy).toEqual({ first: "running", second: "queued" });
    expect(startOrder).toEqual(["A", "B"]);
    expect(resultOrder(run.parentSession)).toEqual(["first", "second"]);
  });
});
