import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEnabledModels } from "../src/model/enabled-models.js";

// readEnabledModels returns a Result: `Ok(undefined)` is "no allowlist here",
// and `Err` is a file that exists and cannot be parsed. The two used to be the
// same value, which is how a corrupt settings.json silently switched scope
// enforcement off while the setting still read "on". Every test below asserts
// the channel first, then the payload.
//
// Pattern resolution (exact provider/modelId, case-folding, getAvailable
// filtering) is exercised through ModelScope.check in model-scope.test.ts —
// that logic is private to the scope now, not a second exported API.

describe("readEnabledModels", () => {
  let agentDir: string;
  let projectDir: string;
  let originalEnv: string | undefined;

  const projectFile = () => join(projectDir, ".pi", "settings.json");
  const globalFile = () => join(agentDir, "settings.json");

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-em-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-em-project-"));
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  function writeProjectRaw(raw: string) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), raw);
  }

  /** The Ok payload, or a failed assertion — the "read succeeded" path. */
  function read(): string[] | undefined {
    return readEnabledModels(projectDir)._unsafeUnwrap();
  }

  it("returns undefined when both settings files are missing", () => {
    expect(read()).toBeUndefined();
  });

  it("returns undefined when field absent from both files", () => {
    writeFileSync(globalFile(), JSON.stringify({ defaultProvider: "openai" }));
    expect(read()).toBeUndefined();
  });

  it("returns enabledModels from global when project file absent", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6", "google/gemma-4-31b-it"],
    }));
    expect(read()).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemma-4-31b-it",
    ]);
  });

  it("returns enabledModels from project when global file absent", () => {
    writeProject({ enabledModels: ["anthropic/claude-haiku-4-5"] });
    expect(read()).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("project overrides global (array replaces wholly, mirrors pi's deep-merge)", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    }));
    writeProject({ enabledModels: ["anthropic/claude-haiku-4-5"] });
    // Project replaces wholly — globals NOT merged in
    expect(read()).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("falls back to global when project file has no enabledModels field", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6"],
    }));
    writeProject({ defaultProvider: "anthropic" }); // project exists but no enabledModels
    expect(read()).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("treats a non-array enabledModels in global as absent", () => {
    writeFileSync(globalFile(), JSON.stringify({ enabledModels: "anthropic/claude-sonnet-4-6" }));
    expect(read()).toBeUndefined();
  });

  it("treats a non-array enabledModels in the project file as absent", () => {
    writeProject({ enabledModels: "anthropic/claude-haiku-4-5" });
    // Not a list, so it is not a list to enforce: fall through to global, which
    // has nothing either. Absent, not broken.
    expect(read()).toBeUndefined();
  });

  it("returns Err naming the project file when it cannot be parsed", () => {
    writeProjectRaw("not json {{{");
    const result = readEnabledModels(projectDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().path).toBe(projectFile());
  });

  it("returns Err naming the global file when only it cannot be parsed", () => {
    // The project file is fine and simply has no field, so the read reaches
    // global — and that is the file the caller has to hear about.
    writeProject({ defaultProvider: "anthropic" });
    writeFileSync(globalFile(), "not json {{{");
    const result = readEnabledModels(projectDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().path).toBe(globalFile());
  });

  it("reports a corrupt project file rather than the global list it hides", () => {
    // The project file outranks global, so its failure is the one that matters:
    // falling through to global here would enforce a list the user replaced.
    writeFileSync(globalFile(), JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-4-6"] }));
    writeProjectRaw("{{{");
    const result = readEnabledModels(projectDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().path).toBe(projectFile());
  });
});
