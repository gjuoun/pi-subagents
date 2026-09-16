import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(tool: any, result: any): string {
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded: false, isPartial: false },
    theme,
    { isError: result.isError },
  ).render(120).join("\n");
}

describe("Agent tool block background", () => {
  /** A theme that can paint a background, the way pi's own does. */
  const bgTheme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    getBgAnsi: (c: string) => `<${c}>`,
    bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  } as any;

  const renderWith = (details: unknown, opts: { isPartial?: boolean; isError?: boolean } = {}) =>
    agentTool().renderResult(
      { content: [{ type: "text", text: "the result" }], details },
      { expanded: false, isPartial: opts.isPartial ?? false },
      bgTheme,
      { isError: opts.isError ?? false },
    ).render(120).join("\n");

  it("paints the result lines with the run's state background", () => {
    // The call line has always been tinted; a result that was not read as a second object.
    expect(renderWith({ status: "running" })).toContain("<bg:toolPendingBg>");
    expect(renderWith({ status: "completed", durationMs: 1200 })).toContain("<bg:toolSuccessBg>");
    expect(renderWith({ status: "error", error: "boom" })).toContain("<bg:toolErrorBg>");
    expect(renderWith({ status: "aborted" })).toContain("<bg:toolErrorBg>");
    expect(renderWith({ status: "stopped" })).toContain("<bg:toolErrorBg>");
    expect(renderWith(undefined, { isError: true })).toContain("<bg:toolErrorBg>");
  });

  it("paints the call line whether or not the agent has a colour", () => {
    const call = (over: Record<string, unknown>, context = { isPartial: false, isError: false }) =>
      agentTool().renderCall({ subagent_type: "finder", description: "d", ...over }, bgTheme, context).render(120).join("\n");

    expect(call({})).toContain("<toolSuccessBg>");
    expect(call({}, { isPartial: true, isError: false })).toContain("<toolPendingBg>");
    expect(call({}, { isPartial: false, isError: true })).toContain("<toolErrorBg>");
  });

  it("renders plain for a theme that cannot paint a background", () => {
    const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getBgAnsi: () => "" } as any;
    const output = agentTool().renderResult(
      { content: [{ type: "text", text: "the result" }], details: { status: "completed", durationMs: 10 } },
      { expanded: false, isPartial: false },
      plain,
      { isError: false },
    ).render(120).join("\n");

    expect(output).toContain("the result".length ? "Done" : "");
  });
});

describe("Agent tool invocation error rendering", () => {
  it("shows a Pi tool error instead of structured terminal status", () => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: 'Cannot run with isolation: "worktree" — Git probe failed.' }],
      isError: true,
      details: { status: "aborted" },
    });

    expect(output).toContain('Cannot run with isolation: "worktree" — Git probe failed.');
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });

  it.each([
    ["missing details", undefined],
    ["empty details", {}],
    ["unknown status", { status: "unknown" }],
    ["a status with no rendering of its own", { status: "queued" }],
  ])("shows the real result text for %s", (_name, details) => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: "Unstructured Agent result." }],
      isError: false,
      details,
    });

    expect(output).toContain("Unstructured Agent result.");
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });
});
