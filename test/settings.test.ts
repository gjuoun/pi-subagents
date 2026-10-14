import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ParentContext, type ParentContextShape } from "../src/services/parent-context.service.js";
import { DEFAULT_MAX_CONCURRENT, Settings } from "../src/services/settings.js";

/** settings.test.ts — maxConcurrent precedence and default (JW-166 Step 8). */

describe("v2 settings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function parentWith(global?: unknown, project?: unknown): ParentContextShape {
    const agentDir = mkdtempSync(join(tmpdir(), "v2-settings-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "v2-settings-cwd-"));
    dirs.push(agentDir, cwd);
    if (global !== undefined) writeFileSync(join(agentDir, "subagents.json"), JSON.stringify(global));
    if (project !== undefined) {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(project));
    }
    return { cwd, agentDir, sessionFile: undefined, model: undefined, modelRegistry: {} };
  }

  const read = (parent: ParentContextShape) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* Settings;
        return yield* settings.maxConcurrent;
      }).pipe(Effect.provide(Settings.live), Effect.provideService(ParentContext, parent)),
    );

  it("defaults to 10", async () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(10);
    expect(await read(parentWith())).toBe(10);
  });

  it("reads the global file", async () => {
    expect(await read(parentWith({ maxConcurrent: 3, schedulingEnabled: true }))).toBe(3);
  });

  it("lets the project file win", async () => {
    expect(await read(parentWith({ maxConcurrent: 3 }, { maxConcurrent: 1 }))).toBe(1);
  });

  it("ignores invalid values", async () => {
    expect(await read(parentWith({ maxConcurrent: 0 }, { maxConcurrent: "two" }))).toBe(10);
  });
});
