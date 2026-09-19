/**
 * jev-tool.e2e.test.ts — the `jev` tool's registration surface, scripted.
 *
 * Real activation path (subagentsExtension with a mock pi that captures
 * registered tools), real settings load from a temp project cwd, stubbed
 * classifier (askJev module-mocked — no network, no model), one real tool call.
 * Asserts the two promises that matter: the tool is ABSENT by default and
 * PRESENT when `.pi/subagents.json` sets `jevEnabled: true`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/tools/jev/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/jev/client.js")>("../../src/tools/jev/client.js");
  return {
    ...actual,
    askJev: vi.fn(async () => ({
      ok: true,
      choice: "worker",
      probabilities: { worker: 0.68, finder: 0.15 },
      confidence: 0.64,
      inputTokens: 2087,
      outputTokens: 116,
      costUsd: 0.000087654,
      ms: 300,
    })),
  };
});

import subagentsExtension from "../../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

const PREV_CWD = process.cwd();
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "jev-e2e-"));
});

beforeEach(() => {
  vi.stubEnv("JEV_API_KEY", "sk-test");
  vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");
});

afterEach(() => {
  process.chdir(PREV_CWD);
  rmSync(cwd, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("jev tool registration", () => {
  it("is absent by default (jevEnabled defaults to off)", () => {
    process.chdir(cwd);
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    expect(tools.has("jev")).toBe(false);
  });

  it("is registered and answers a decision when jevEnabled is true", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ jevEnabled: true }));
    process.chdir(cwd);
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const tool = tools.get("jev");
    expect(tool).toBeDefined();
    const out = await tool.execute("tc", { task: "build a parser" }, undefined, undefined, undefined);
    expect(out.content[0].text).toContain("winner: worker");
    expect(out.content[0].text).toContain("confidence: 0.64");
  });
});
