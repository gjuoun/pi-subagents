/**
 * conversation-viewer-agent-frame.test.ts — the open agent session's frame is drawn in that agent
 * type's colour (agent-view-tui, Step 7), and the colour costs nothing in alignment.
 *
 * The frame is hand-drawn: the sides come from `row()`'s `│`, the top from `hrTop` and the bottom
 * from `hrBot`. A configured agent colour is arbitrary hex, so it cannot ride a theme token — it
 * takes the literal truecolor path in `agent-color.ts`. That is why the escapes are also checked
 * to be zero-width: a painted frame that shifted its padding would be worse than an uncoloured one.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/config/registry/agent-types.js";
import type { AgentConfig, AgentRecord } from "../src/lib/types.js";
import { ConversationViewer } from "../src/ui/viewer/conversation-viewer.js";

const CODED_TYPE = "amber-frame-agent";
/** #FFC800 — the amber the marks use, as literal truecolor. */
const AMBER_SGR = "\u001b[38;2;255;200;0m";
const CODED_CONFIG: AgentConfig = {
  name: CODED_TYPE,
  displayName: "Amber Frame",
  color: "#FFC800",
  description: "Frames itself",
  extensions: false,
  skills: false,
  systemPrompt: "Frame the conversation.",
  promptMode: "replace",
};

/** Token-named escapes, so a frame line's colour is asserted rather than guessed at. */
const TOKEN_INDEX: Record<string, number> = { border: 240, accent: 200, dim: 245, muted: 250, text: 255 };
function tokenTheme() {
  return {
    fg: (color: string, text: string) => `\u001b[38;5;${TOKEN_INDEX[color] ?? 99}m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as any;
}

const FRAME_GLYPHS = /[│╭╮╰╯]/;
const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

function mockTui(rows: number, columns: number) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}
function mockSession() {
  return {
    messages: [],
    subscribe: () => () => {},
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}
function recordFor(type: string): AgentRecord {
  return {
    id: "test-1",
    type,
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: mockSession(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  } as any;
}

function render(type: string, width = 60, rows = 30): string[] {
  const viewer = new ConversationViewer(
    mockTui(rows, width), mockSession(), recordFor(type), undefined, tokenTheme(), vi.fn(),
  );
  return viewer.render(width);
}

describe("ConversationViewer frame colour", () => {
  it("paints the frame in the agent type's configured colour", () => {
    registerAgents(new Map([[CODED_TYPE, CODED_CONFIG]]));
    try {
      const lines = render(CODED_TYPE);
      expect(lines[0]).toContain(`${AMBER_SGR}╭`);                 // top edge
      expect(lines[lines.length - 1]).toContain(`${AMBER_SGR}╰`);  // bottom edge
      expect(lines[1]).toContain(`${AMBER_SGR}│`);                 // a side
      // …and it is the agent's colour, not the theme's border token standing in for it. Only the
      // frame is repainted: the header rule inside it keeps the theme's dim token.
      expect(lines.join("\n")).not.toContain("38;5;240");
      expect(lines[2]).toContain("\u001b[38;5;245m─");
    } finally {
      registerAgents(new Map());
    }
  });

  it("keeps the theme's own frame tokens for an agent with no colour", () => {
    const lines = render("general-purpose");
    expect(lines[0]).toContain("\u001b[38;5;240m╭");                  // border token, top
    expect(lines[lines.length - 1]).toContain("\u001b[38;5;200m╰");   // accent token, bottom
    expect(lines.join("\n")).not.toContain("38;2;");                  // no literal truecolor
  });

  it("keeps every frame line exactly as wide as it was: the escapes are zero-width", () => {
    registerAgents(new Map([[CODED_TYPE, CODED_CONFIG]]));
    try {
      for (const width of [40, 60, 100]) {
        for (const line of render(CODED_TYPE, width)) {
          expect(FRAME_GLYPHS.test(line), `every line is part of the frame: ${JSON.stringify(line)}`).toBe(true);
          expect(visibleWidth(line), `ANSI-aware width at ${width}: ${JSON.stringify(line)}`).toBe(width);
          expect(strip(line).length, `stripped width at ${width}: ${JSON.stringify(line)}`).toBe(width);
        }
      }
    } finally {
      registerAgents(new Map());
    }
  });
});
