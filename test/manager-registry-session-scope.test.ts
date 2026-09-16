/**
 * manager-registry-session-scope.test.ts — Symbol.for("pi-subagents:managers").
 *
 * The single-slot registry (`Symbol.for("pi-subagents:manager")`) is claimed by the first
 * activation in a process, so a host that keeps many sessions in one process — a web UI, a daemon —
 * gets `undefined` from `getRecord(runId)` for every session but the first, and with it loses the
 * child's `sessionFile` and live session. The per-session map fixes that without touching the
 * single slot's semantics (see manager-registry-guard.test.ts for those).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/agent-runner.js")>("../src/agent/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const MANAGERS_KEY = Symbol.for("pi-subagents:managers");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctxFor(sessionId: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => sessionId), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

/** Activate the extension, run its first session_start, and hand back the entry for that session. */
async function activate(sessionId: string) {
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);
  await lifecycle.get("session_start")?.({}, ctxFor(sessionId));
  return { tools, lifecycle, entry: (globalThis as any)[MANAGERS_KEY]?.get(sessionId) };
}

async function spawnBackground(tools: Map<string, any>, sessionId: string): Promise<string> {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "session scope test", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctxFor(sessionId),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const priorSlot = (globalThis as any)[MANAGER_KEY];
const priorMap = (globalThis as any)[MANAGERS_KEY];
afterEach(() => {
  if (priorSlot === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = priorSlot;
  if (priorMap === undefined) delete (globalThis as any)[MANAGERS_KEY];
  else (globalThis as any)[MANAGERS_KEY] = priorMap;
  vi.mocked(runAgent).mockReset();
});

describe("per-session manager registry", () => {
  it("resolves each session's own agent ids, while the single slot still belongs to the first", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[MANAGERS_KEY];

    // Two sessions in one process — the shape a long-lived host has.
    const first = await activate("session-1");
    const second = await activate("session-2");

    const firstId = await spawnBackground(first.tools, "session-1");
    const secondId = await spawnBackground(second.tools, "session-2");

    // The legacy slot keeps its documented semantics: the first activation owns it.
    expect((globalThis as any)[MANAGER_KEY]).toBe(first.entry);

    const managers = (globalThis as any)[MANAGERS_KEY] as Map<string, any>;
    expect([...managers.keys()].sort()).toEqual(["session-1", "session-2"]);

    // Each session resolves its own run …
    expect(managers.get("session-1").getRecord(firstId)).toBeDefined();
    expect(managers.get("session-2").getRecord(secondId)).toBeDefined();

    // … and not the other session's, which is the whole point: records are per manager.
    expect(managers.get("session-1").getRecord(secondId)).toBeUndefined();
    expect(managers.get("session-2").getRecord(firstId)).toBeUndefined();
  });

  it("drops only its own entry on shutdown, leaving the other sessions' entries intact", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[MANAGERS_KEY];

    const first = await activate("session-1");
    const second = await activate("session-2");
    const managers = (globalThis as any)[MANAGERS_KEY] as Map<string, any>;

    await first.lifecycle.get("session_shutdown")?.();
    expect([...managers.keys()]).toEqual(["session-2"]);

    await second.lifecycle.get("session_shutdown")?.();
    expect([...managers.keys()]).toEqual([]);
  });
});
