import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ParentContext, type ParentContextShape } from "../src/services/parent-context.service.js";
import { DEFAULT_MAX_CONCURRENT, Settings } from "../src/services/settings.js";

/** settings.test.ts — maxConcurrent precedence, config.json read and legacy absorb (JW-166). */

describe("v2 settings", () => {
  const dirs: string[] = [];
  const prevHome = process.env.HOME;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  function parentWith(global?: unknown, project?: unknown): ParentContextShape {
    const agentDir = mkdtempSync(join(tmpdir(), "v2-settings-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "v2-settings-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "v2-settings-home-"));
    dirs.push(agentDir, cwd, home);
    // The global file is `~/.pi/eyu/config.json`, so a global case needs its own HOME.
    process.env.HOME = home;
    if (global !== undefined) {
      writeConfig(home, { subagents: global });
    }
    if (project !== undefined) {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(project));
    }
    return { cwd, agentDir, sessionFile: undefined, model: undefined, modelRegistry: {} };
  }

  function writeConfig(home: string, config: unknown): void {
    mkdirSync(join(home, ".pi", "eyu"), { recursive: true });
    writeFileSync(join(home, ".pi", "eyu", "config.json"), JSON.stringify(config));
  }

  function homeDir(): string {
    return process.env.HOME as string;
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

  it("reads the global config.json under the subagents key", async () => {
    expect(await read(parentWith({ maxConcurrent: 3, schedulingEnabled: true }))).toBe(3);
  });

  it("absorbs a legacy subagents.json once into config.json", async () => {
    const parent = parentWith();
    mkdirSync(join(homeDir(), ".pi", "eyu"), { recursive: true });
    writeFileSync(join(homeDir(), ".pi", "eyu", "subagents.json"), JSON.stringify({ maxConcurrent: 4 }));

    expect(await read(parent)).toBe(4);

    const config = JSON.parse(readFileSync(join(homeDir(), ".pi", "eyu", "config.json"), "utf8"));
    expect(config).toEqual({ subagents: { maxConcurrent: 4 } });
    const files = readdirSync(join(homeDir(), ".pi", "eyu"));
    expect(files.filter((file) => file.startsWith("subagents.json.bak-"))).toHaveLength(1);
    expect(files).not.toContain("subagents.json");
  });

  it("absorbs without clobbering a sibling key", async () => {
    const parent = parentWith();
    writeConfig(homeDir(), { display: { thinking: "fold" } });
    writeFileSync(join(homeDir(), ".pi", "eyu", "subagents.json"), JSON.stringify({ maxConcurrent: 5 }));

    expect(await read(parent)).toBe(5);
    expect(JSON.parse(readFileSync(join(homeDir(), ".pi", "eyu", "config.json"), "utf8"))).toEqual({
      display: { thinking: "fold" },
      subagents: { maxConcurrent: 5 },
    });
  });

  it("lets the project file win", async () => {
    expect(await read(parentWith({ maxConcurrent: 3 }, { maxConcurrent: 1 }))).toBe(1);
  });

  it("ignores invalid values", async () => {
    expect(await read(parentWith({ maxConcurrent: 0 }, { maxConcurrent: "two" }))).toBe(10);
  });
});
