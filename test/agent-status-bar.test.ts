import { describe, expect, it } from "vitest";
import { AgentStatusBar, type StatusClock } from "../src/ui/agent-status-bar.js";
import type { StatusAgent } from "../src/ui/agent-status-line.js";

const amber = () => "#FFC800";
const running = (id = "a1", type = "finder"): StatusAgent => ({ id, type, status: "running" });
const queued = (id = "q1", type = "finder"): StatusAgent => ({ id, type, status: "queued" });
const completed = (id = "a1", type = "finder"): StatusAgent => ({ id, type, status: "completed" });

/** Records what was asked of the clock, and lets a test fire the tick by hand. */
function fakeClock() {
  const set: number[] = [];
  const clear: unknown[] = [];
  let tick: (() => void) | undefined;
  const clock: StatusClock = {
    set(fn) { set.push(set.length + 1); tick = fn; return set.length; },
    clear(handle) { clear.push(handle); tick = undefined; },
  };
  return { clock, set, clear, fire: () => tick?.() };
}

function harness(agents: StatusAgent[]) {
  const writes: Array<string | undefined> = [];
  const { clock, ...rest } = fakeClock();
  const bar = new AgentStatusBar({
    listAgents: () => agents,
    resolveColor: amber,
    clock,
  });
  bar.setUICtx({ setStatus: (_key, text) => writes.push(text) });
  return { bar, writes, ...rest };
}

describe("AgentStatusBar", () => {
  it("writes one mark per agent: filled+blinking for running, hollow for queued", () => {
    const { writes } = harness([running(), queued()]);
    expect(writes.at(-1)).toBe("\u001b[38;2;255;200;0m●\u001b[39m\u001b[38;2;255;200;0m○\u001b[39m");
  });

  it("does not emit a second time when the frame is identical", () => {
    const h = harness([running()]);
    const before = h.writes.length;
    h.bar.update();
    expect(h.writes.length).toBe(before);
  });

  it("arms the clock only while something runs, and stops it when nothing does", () => {
    const agents: StatusAgent[] = [running()];
    const h = harness(agents);
    expect(h.set.length).toBe(1);
    expect(h.clear.length).toBe(0);
    // the run settles: finished marks are solid, so the clock must stop
    agents.splice(0, 1, completed());
    h.bar.markFinished("a1");
    expect(h.clear.length).toBe(1);
    expect(h.writes.at(-1)).toBe("\u001b[38;2;255;200;0m●\u001b[39m");
  });

  it("blinks by alternating phase, and each beat changes the frame", () => {
    const h = harness([running()]);
    const first = h.writes.at(-1);
    h.fire();
    const second = h.writes.at(-1);
    expect(second).not.toBe(first);
    expect(second).toContain("\u001b[38;2;89;70;0m");
  });

  it("drops a finished mark at the next turn, clearing the status with it", () => {
    const agents: StatusAgent[] = [running()];
    const h = harness(agents);
    agents.splice(0, 1, completed());
    h.bar.markFinished("a1");
    h.bar.onTurnStart();
    expect(h.writes.at(-1)).toBeUndefined();
  });

  it("clears the status on dispose", () => {
    const h = harness([queued()]);
    h.bar.dispose();
    expect(h.writes.at(-1)).toBeUndefined();
  });
});
