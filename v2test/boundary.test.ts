import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CatalogError, RegistryError, SessionError } from "../v2src/domain/errors.js";
import { makeRuntime } from "../v2src/layers.js";
import { runTool } from "../v2src/pi/boundary.js";
import { AgentRegistry } from "../v2src/services/agent-registry.js";
import { E2EHandle, V2_HANDLE_KEY } from "../v2src/services/e2e-handle.js";

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
      CatalogError.UnknownAgentType({ requested: "z", available: ["general-purpose"] }),
      RegistryError.AgentNotFound({ id: "id-1" }),
      RegistryError.AgentBusy({ id: "id-1", name: "n" }),
      SessionError.SpawnFailed({ reason: "boom" }),
      SessionError.RunFailed({ id: "id-1", reason: "boom" }),
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
    const published = () => (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY];
    const rt = makeRuntime(fakePi());
    await rt.runPromise(
      Effect.gen(function* () {
        yield* AgentRegistry;
        yield* E2EHandle;
      }),
    );
    expect(published()).toBeDefined();
    await rt.dispose();
    expect(published()).toBeUndefined();
  });
});
