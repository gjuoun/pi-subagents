import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "../src/domain/agent.js";
import type { ViewerMessage } from "../src/domain/child-session.js";
import { ConversationViewer, type ViewerSource } from "../src/ui/viewer/conversation-viewer.js";

/** viewer.test.ts — the conversation viewer port (JW-166 Step 15). */

const plain = { fg: (_c: string, t: string) => t };
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";

const snap: AgentSnapshot = {
  id: "abcd1234",
  type: "scout",
  name: "scout",
  handle: "scout",
  description: "slow read",
  status: "running",
  runs: 0,
  startedAt: Date.now() - 2_000,
  lastText: "",
  toolUses: 1,
  turns: 1,
  wrappedUp: false,
  model: "glm-5.3-flash",
  thinking: "high",
  tokens: 1_500,
  contextPercent: 3,
};

const conversation: ViewerMessage[] = [
  { role: "user", blocks: [{ type: "text", text: "read secret.txt" }] },
  { role: "assistant", blocks: [{ type: "text", text: "Reading now." }, { type: "toolCall", name: "read", arguments: { path: "secret.txt" } }] },
  { role: "toolResult", toolName: "read", blocks: [{ type: "text", text: "LIVE-SECRET-1" }] },
];

function setup(messages: ViewerMessage[] = conversation, status = snap.status) {
  let listener: (() => void) | undefined;
  const source: ViewerSource = {
    snapshot: () => ({ ...snap, status }),
    messages: () => messages,
    onChange: (l) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    steer: vi.fn(async (m: string) => `sent: ${m}`),
    stop: vi.fn(),
  };
  const tui = { terminal: { rows: 30 }, requestRender: vi.fn() };
  const done = vi.fn();
  const viewer = new ConversationViewer(tui, source, plain, done);
  return { viewer, source, tui, done, fire: () => listener?.(), hasListener: () => listener !== undefined };
}

describe("v2 conversation viewer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("frames the conversation on a bottom identity block, full screen", () => {
    const { viewer } = setup();
    const lines = viewer.render(100);
    expect(lines).toHaveLength(30);
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.join("\n")).toContain("▍You");
    // One line per tool use — the tool and its arguments, never the result body.
    expect(lines.join("\n")).toContain('✅read: {"path":"secret.txt"}');
    expect(lines.join("\n")).not.toContain("LIVE-SECRET-1");
    expect(lines.join("\n")).not.toContain("⚙ ");
    // Bottom-up: the rule, the position-and-keys footer, the description, the identity row.
    expect(lines.at(-5)?.startsWith("├")).toBe(true);
    expect(lines.at(-4)).toMatch(/\d+-\d+ of \d+ lines · /);
    expect(lines.at(-3)).toContain("slow read");
    expect(lines.at(-2)).toContain("scout  glm-5.3-flash - high  1.5k 3%");
    expect(lines.at(-2)).not.toContain("slow read");
  });

  it("repaints on every session change", () => {
    const { tui, fire } = setup();
    fire();
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("steers from the composer: Enter, type, Enter", async () => {
    const { viewer, source } = setup();
    viewer.handleInput(ENTER);
    expect(viewer.composing).toBe(true);
    for (const ch of "go deeper") viewer.handleInput(ch);
    viewer.handleInput(ENTER);
    expect(viewer.composing).toBe(false);
    expect(source.steer).toHaveBeenCalledWith("go deeper");
    await Promise.resolve();
    await Promise.resolve();
    expect(viewer.render(100).at(-4)).toContain("sent: go deeper");
  });

  it("closes on Esc and stops listening", () => {
    const { viewer, done, hasListener } = setup();
    viewer.handleInput(ESC);
    expect(done).toHaveBeenCalledTimes(1);
    expect(hasListener()).toBe(false);
  });

  it("stays open when the agent has finished", () => {
    const { viewer, done } = setup(conversation, "done");
    expect(viewer.render(100).at(-2)).toContain("✅");
    expect(done).not.toHaveBeenCalled();
  });

  it("scrolls back through a long conversation", () => {
    const many: ViewerMessage[] = Array.from({ length: 40 }, (_, i) => ({ role: "user", blocks: [{ type: "text", text: `line ${i}` }] }));
    const { viewer } = setup(many);
    const tail = viewer.render(80).join("\n");
    expect(tail).toContain("line 39");
    for (let i = 0; i < 30; i++) viewer.handleInput(UP);
    const scrolled = viewer.render(80).join("\n");
    expect(scrolled).not.toContain("line 39");
  });

  it("asks the source to stop on x", () => {
    const { viewer, source } = setup();
    viewer.handleInput("x");
    expect(source.stop).toHaveBeenCalledTimes(1);
  });
});
