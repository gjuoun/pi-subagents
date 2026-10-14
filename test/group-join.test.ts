import type { Context } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentResultMessage } from "../src/domain/subagent-result.js";
import {
  BATCH_WINDOW_MS,
  GROUP_TIMEOUT_MS,
  GroupJoin,
  SOLO_HOLD_MS,
  STRAGGLER_TIMEOUT_MS,
} from "../src/services/group-join.js";
import { ResultNotifier } from "../src/services/result-notifier.js";
import { agentCall, isParentCall, runV2, type V2Run } from "./helpers/v2-runner.js";

/**
 * group-join.test.ts — the smart join (JW-166 Step 9): background agents from one parent turn
 * are announced together; timeouts deliver partial groups and regroup stragglers.
 */

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";

const results = (session: AgentSession): string[] =>
  session.messages
    .filter((m) => (m as { customType?: string }).customType === "subagent-result")
    .map((m) => textOf(m as { content?: unknown }));

describe("v2 smart join (e2e)", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("announces two background agents from one turn as one message", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: (ctx: Context) => {
        if (!isParentCall(ctx)) return ctx.messages.map(textOf).join("").includes("TASK-A") ? "ANSWER-A" : "ANSWER-B";
        const spawned = ctx.messages.some((m) => m.role === "toolResult");
        return spawned
          ? "PARENT-FINAL"
          : [
              agentCall({ prompt: "TASK-A", description: "a", run_in_background: true }),
              agentCall({ prompt: "TASK-B", description: "b", run_in_background: true }),
            ];
      },
    });
    const all = results(run.parentSession);
    expect(all).toHaveLength(1);
    expect(all[0]).toContain("ANSWER-A");
    expect(all[0]).toContain("ANSWER-B");
  });

  it("announces a lone background agent on its own", async () => {
    run = await runV2({
      prompt: "delegate",
      respond: (ctx: Context) => {
        if (!isParentCall(ctx)) return "SOLO-ANSWER";
        return ctx.messages.some((m) => m.role === "toolResult")
          ? "PARENT-FINAL"
          : agentCall({ prompt: "TASK", description: "solo", run_in_background: true });
      },
    });
    const all = results(run.parentSession);
    expect(all).toHaveLength(1);
    expect(all[0]).not.toContain("Background agent group completed");
    expect(all[0]).toContain("SOLO-ANSWER");
  });
});

/** A message as the registry would build it for one settled agent. */
const msg = (id: string, text: string): SubagentResultMessage =>
  SubagentResultMessage.fromAgent(
    {
      id,
      type: "worker",
      name: "worker",
      handle: "worker",
      description: id,
      status: "done",
      runs: 1,
      startedAt: 0,
      finishedAt: 1,
      lastText: text,
      toolUses: 0,
      turns: 1,
      wrappedUp: false,
      tokens: 0,
    },
    "done",
    text,
  );

describe("v2 smart join timings (TestClock)", () => {
  const program = (body: (sent: SubagentResultMessage[]) => Effect.Effect<void, never, GroupJoin>) => {
    const sent: SubagentResultMessage[] = [];
    const notifier = Layer.succeed(ResultNotifier, { deliver: (m) => Effect.sync(() => void sent.push(m)) });
    const join = Layer.effect(GroupJoin, GroupJoin.make).pipe(Layer.provide(notifier));
    return Effect.runPromise(body(sent).pipe(Effect.provide(Layer.merge(join, TestClock.layer())), Effect.scoped)).then(
      () => sent,
    );
  };

  it("delivers a partial group at 30s and the straggler 15s after it settles", async () => {
    const log: string[][] = [];
    await program((sent) =>
      Effect.gen(function* () {
        const join = yield* GroupJoin;
        yield* join.register("a", "turn-1");
        yield* join.register("b", "turn-1");
        yield* TestClock.adjust(BATCH_WINDOW_MS);
        yield* join.settle("a", msg("a", "A-TEXT"));
        yield* TestClock.adjust(GROUP_TIMEOUT_MS - 1);
        log.push(sent.map((m) => m.content));
        yield* TestClock.adjust(1);
        log.push(sent.map((m) => m.content));
        yield* join.settle("b", msg("b", "B-TEXT"));
        yield* TestClock.adjust(STRAGGLER_TIMEOUT_MS);
        log.push(sent.map((m) => m.content));
      }),
    );
    expect(log[0]).toHaveLength(0);
    expect(log[1]).toHaveLength(1);
    expect(log[1][0]).toContain("partial — others still running");
    expect(log[1][0]).toContain("A-TEXT");
    expect(log[2]).toHaveLength(2);
    expect(log[2][1]).toContain("B-TEXT");
  });

  it("drops a consumed result from a pending solo delivery", async () => {
    const sent = await program(() =>
      Effect.gen(function* () {
        const join = yield* GroupJoin;
        yield* join.register("a", "turn-1");
        yield* TestClock.adjust(BATCH_WINDOW_MS);
        yield* join.settle("a", msg("a", "A-TEXT"));
        yield* join.consume("a");
        yield* TestClock.adjust(SOLO_HOLD_MS);
      }),
    );
    expect(sent).toHaveLength(0);
  });

  it("closes a batch when a call from another turn arrives", async () => {
    const sent = await program(() =>
      Effect.gen(function* () {
        const join = yield* GroupJoin;
        yield* join.register("a", "turn-1");
        yield* join.register("b", "turn-2");
        yield* TestClock.adjust(BATCH_WINDOW_MS);
        yield* join.settle("a", msg("a", "A-TEXT"));
        yield* join.settle("b", msg("b", "B-TEXT"));
        yield* TestClock.adjust(SOLO_HOLD_MS);
      }),
    );
    expect(sent.map((m) => m.content.includes("group completed"))).toEqual([false, false]);
  });
});
