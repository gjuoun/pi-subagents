import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runTool } from "../v2src/boundary.js";
import { AgentBusy, AgentNotFound, RunFailed, SpawnFailed, UnknownAgentType } from "../v2src/errors.js";
import { makeRuntime } from "../v2src/runtime.js";

const fakePi = () => ({ sendMessage: vi.fn() }) as unknown as ExtensionAPI;

// One runtime per test, always disposed, so a leaked layer cannot bleed between cases.
const withRuntime = async (run: (rt: ReturnType<typeof makeRuntime>) => Promise<void>) => {
  const rt = makeRuntime(fakePi());
  try {
    await run(rt);
  } finally {
    await rt.dispose();
  }
};

describe("boundary.runTool", () => {
  it("(a) maps a success to the plain text the parent model sees", async () => {
    await withRuntime(async (rt) => {
      const result = await runTool(rt, Effect.succeed("x"), undefined);
      expect(result).toEqual({ content: [{ type: "text", text: "x" }] });
    });
  });

  it("(b) renders every V2Error as Error [Tag]: message and stays plain JSON", async () => {
    const errors = [
      new UnknownAgentType({ requested: "z", available: ["general-purpose"] }),
      new AgentNotFound({ id: "id-1" }),
      new AgentBusy({ id: "id-1", name: "n" }),
      new SpawnFailed({ reason: "boom" }),
      new RunFailed({ id: "id-1", reason: "boom" }),
    ] as const;
    await withRuntime(async (rt) => {
      for (const error of errors) {
        const result = await runTool(rt, Effect.fail(error), undefined);
        expect(result.content[0]).toEqual({ type: "text", text: expect.stringMatching(new RegExp(`^Error \\[${error._tag}\\]: .+`)) });
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      }
    });
  });

  it("(c) re-throws a defect as a plain Error", async () => {
    await withRuntime(async (rt) => {
      const thrown = await runTool(rt, Effect.die(new Error("bug")), undefined).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("bug");
    });
  });

  it("(d) maps an aborted signal to aborted text and runs onInterrupt once", async () => {
    await withRuntime(async (rt) => {
      const spy = vi.fn();
      const ctrl = new AbortController();
      const pending = runTool(
        rt,
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => spy()))),
        ctrl.signal,
      );
      ctrl.abort();
      const result = await pending;
      expect(result.content[0]).toEqual({ type: "text", text: "Agent was aborted." });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("(e) runtime.dispose() runs the Registry finalizer exactly once", async () => {
    const onDispose = vi.fn();
    const rt = makeRuntime(fakePi(), { onDispose });
    await rt.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });
});
