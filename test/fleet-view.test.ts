import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../src/domain/agent.js";
import { FINISHED_LINGER_MS, FLEET_KEY, type FleetTheme, type FleetUi, FleetView } from "../src/ui/fleet-view.js";

/**
 * fleet-view.test.ts — the FleetView port (JW-166 Step 14), cases ported from the v1 suite's
 * test/fleet-list.test.ts minus workflows, cost and the enable toggle.
 */

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";

/** A theme that tags colours, so tests can see which colour a cell got. */
const tagged: FleetTheme = { fg: (color, text) => `<${color}>${text}</${color}>` };
const plain: FleetTheme = { fg: (_c, text) => text };

let now = 100_000;
const snap = (over: Partial<AgentSnapshot>): AgentSnapshot => ({
  id: "a",
  type: "scout",
  name: "scout",
  handle: "scout",
  description: "slow scan",
  status: "running",
  runs: 0,
  startedAt: now - 11_000,
  lastText: "",
  toolUses: 0,
  turns: 0,
  wrappedUp: false,
  model: "glm-5.3-flash",
  thinking: "high",
  tokens: 42_000,
  contextPercent: 9,
  ...over,
});

function harness(snapshots: AgentSnapshot[], editorText = "") {
  let widget: ((tui: unknown, theme: FleetTheme) => { render(width: number): string[] }) | undefined;
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const opened: string[] = [];
  const ui: FleetUi = {
    setWidget: (key, content) => {
      if (key === FLEET_KEY) widget = content;
    },
    onTerminalInput: (handler) => {
      input = handler;
      return () => {};
    },
    getEditorText: () => editorText,
  };
  const view = new FleetView(() => snapshots, (id) => void opened.push(id), { now: () => now });
  view.attach(ui);
  return {
    view,
    opened,
    key: (data: string) => input?.(data),
    lines: (width = 120, theme = plain) => widget?.(undefined, theme).render(width) ?? [],
    hasWidget: () => widget !== undefined,
  };
}

describe("v2 FleetView", () => {
  let h: ReturnType<typeof harness> | undefined;
  afterEach(() => {
    h?.view.dispose();
    h = undefined;
    now = 100_000;
  });

  it("does not register a widget when there are no agents", () => {
    h = harness([]);
    expect(h.hasWidget()).toBe(false);
  });

  it("draws the PR #24 left side and <model - thinking>  <tokens ctx%> flush right", () => {
    h = harness([snap({})]);
    const [line] = h.lines(100);
    expect(line).toMatch(/^ {2}○ ⏳ {2}11s {2}scout {2}slow scan +glm-5\.3-flash - high {2}42k 9%$/);
    expect(visibleWidth(line)).toBe(100);
  });

  it("orders agents earliest-launched first and lingers finished ones for a while", () => {
    const rows = [
      snap({ id: "late", name: "late", startedAt: now - 1_000 }),
      snap({ id: "early", name: "early", startedAt: now - 9_000 }),
      snap({ id: "gone", name: "gone", status: "done", finishedAt: now - FINISHED_LINGER_MS - 1 }),
      snap({ id: "fresh", name: "fresh", status: "done", startedAt: now - 500, finishedAt: now - 100 }),
    ];
    h = harness(rows);
    expect(h.view.rows().map((r) => r.id)).toEqual(["early", "late", "fresh"]);
    expect(h.lines()[2]).toContain("✅");
  });

  it("activates on ↓ or ← at an empty prompt, consuming the key", () => {
    h = harness([snap({})]);
    expect(h.key(DOWN)).toEqual({ consume: true });
    expect(h.view.active).toBe(true);
    expect(h.lines()[0]).toContain("●");
    h.view.dispose();
    h = harness([snap({})]);
    expect(h.key(LEFT)).toEqual({ consume: true });
  });

  it("does not activate when the prompt is non-empty", () => {
    h = harness([snap({})], "typing");
    expect(h.key(DOWN)).toBeUndefined();
    expect(h.view.active).toBe(false);
  });

  it("moves, clamps, and leaves on ↑ above the first row or Esc", () => {
    h = harness([snap({ id: "a" }), snap({ id: "b", startedAt: now - 1_000 })]);
    h.key(DOWN);
    h.key(DOWN);
    h.key(DOWN);
    expect(h.view.selected).toBe(2);
    h.key(UP);
    h.key(UP);
    expect(h.view.active).toBe(false);
    h.key(DOWN);
    h.key(ESC);
    expect(h.view.active).toBe(false);
  });

  it("opens the selected agent on Enter", () => {
    h = harness([snap({ id: "a" }), snap({ id: "b", startedAt: now - 1_000 })]);
    h.key(DOWN);
    h.key(DOWN);
    h.key(ENTER);
    expect(h.opened).toEqual(["b"]);
  });

  it("passes other keys through and cancels navigation", () => {
    h = harness([snap({})]);
    h.key(DOWN);
    expect(h.key("x")).toBeUndefined();
    expect(h.view.active).toBe(false);
  });

  it("colours context by pressure: dim, amber from 60%, red from 85%", () => {
    h = harness([snap({ contextPercent: 30 })]);
    expect(h.lines(400, tagged)[0]).toContain("<dim>30%</dim>");
    h.view.dispose();
    h = harness([snap({ contextPercent: 61 })]);
    expect(h.lines(400, tagged)[0]).toContain("<warning>61%</warning>");
    h.view.dispose();
    h = harness([snap({ contextPercent: 90 })]);
    expect(h.lines(400, tagged)[0]).toContain("<error>90%</error>");
  });

  it("collapses overflow into '↓ N more' and never exceeds the width", () => {
    h = harness(Array.from({ length: 8 }, (_, i) => snap({ id: `a${i}`, startedAt: now - 10_000 + i })));
    const lines = h.lines(40);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain("↓ 3 more");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("on a narrow terminal keeps marker, status, clock and name", () => {
    h = harness([snap({})]);
    const [line] = h.lines(22);
    expect(line).toContain("⏳");
    expect(line).toContain("scout");
    expect(visibleWidth(line)).toBeLessThanOrEqual(22);
  });
});
