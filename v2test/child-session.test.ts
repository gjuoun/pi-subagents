import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ChildSession } from "../v2src/child-session.js";
import { RunFailed } from "../v2src/errors.js";

type AnyMessage = { role: string; content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string };

interface Turn {
  text?: string;
  toolCalls?: string[];
  stopReason?: string;
  errorMessage?: string;
  reject?: string;
}

/** A stub AgentSession whose prompt emits the scripted turn into messages + subscribers. */
function stubSession(initial: AnyMessage[] = []) {
  const messages: AnyMessage[] = [...initial];
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  let turn: Turn = {};
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event as AgentSessionEvent);
  };
  const session = {
    get messages() {
      return messages;
    },
    subscribe: (fn: (event: AgentSessionEvent) => void) => {
      listeners.push(fn);
      return () => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    abort: () => {},
    dispose: () => {},
    prompt: async () => {
      const t = turn;
      if (t.reject !== undefined) throw new Error(t.reject);
      if (t.text !== undefined) {
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t.text } });
      }
      for (const tool of t.toolCalls ?? []) emit({ type: "tool_execution_start", toolName: tool });
      messages.push({
        role: "assistant",
        content: t.text !== undefined ? [{ type: "text", text: t.text }] : [],
        stopReason: t.stopReason,
        errorMessage: t.errorMessage,
      });
    },
  };
  const child = new ChildSession(session as unknown as AgentSession, "deadbeef", "general-purpose");
  return { child, setTurn: (t: Turn) => { turn = t; }, messages };
}

const earlierMessage: AnyMessage = {
  role: "assistant",
  content: [{ type: "text", text: "EARLIER-TURN" }],
  stopReason: "stop",
};

describe("ChildSession.prompt", () => {
  it("(a) returns the answer after the start index, never an earlier turn's", async () => {
    const first = stubSession([earlierMessage]);
    first.setTurn({ text: "NEW-ANSWER-1" });
    const outcome = await Effect.runPromise(first.child.prompt("go"));
    expect(outcome.answer).toBe("NEW-ANSWER-1");

    const silent = stubSession([earlierMessage]);
    silent.setTurn({});
    const empty = await Effect.runPromise(silent.child.prompt("go"));
    expect(empty.answer).toBe("");
  });

  it("(b) fails RunFailed with the provider message on a final stopReason error", async () => {
    const stub = stubSession();
    stub.setTurn({ stopReason: "error", errorMessage: "PROVIDER-BOOM" });
    const error = await Effect.runPromise(Effect.flip(stub.child.prompt("go")));
    expect(error).toBeInstanceOf(RunFailed);
    expect(error.reason).toBe("PROVIDER-BOOM");
  });

  it("(c) fails RunFailed with an output token limit message on an empty length stop", async () => {
    const stub = stubSession();
    stub.setTurn({ stopReason: "length" });
    const error = await Effect.runPromise(Effect.flip(stub.child.prompt("go")));
    expect(error).toBeInstanceOf(RunFailed);
    expect(error.reason).toContain("output token limit");
  });

  it("(d) fails RunFailed when session.prompt rejects", async () => {
    const stub = stubSession();
    stub.setTurn({ reject: "kaboom" });
    const error = await Effect.runPromise(Effect.flip(stub.child.prompt("go")));
    expect(error).toBeInstanceOf(RunFailed);
    expect(error.reason).toBe("kaboom");
  });

  it("(e) reports every tool_execution_start to onActivity", async () => {
    const stub = stubSession();
    stub.setTurn({ text: "done", toolCalls: ["read", "bash", "grep"] });
    const seen: string[] = [];
    const outcome = await Effect.runPromise(stub.child.prompt("go", (tool) => seen.push(tool)));
    expect(seen).toEqual(["read", "bash", "grep"]);
    expect(outcome.toolUses).toBe(3);
    expect(outcome.lastTool).toBe("grep");
  });
});
