import { describe, expect, it } from "vitest";
import {
  blockTint,
  COMPACT_BODY_LINES,
  FULL_BODY_LINES,
  indexToolResults,
  PARAMS_FOLDED,
  PARAMS_LINE_LIMIT,
  paramLineCount,
  renderToolBlock,
  resultText,
  visibleWidth,
} from "../src/ui/viewer/viewer-blocks.js";

const WIDTH = 100;

function call(name: string, args: Record<string, any> = {}, id = "c1") {
  return { id, name, arguments: args };
}

function result(toolCallId: string, text: string, extra: Record<string, any> = {}) {
  return { toolCallId, toolName: "t", isError: false, content: [{ type: "text", text }], details: {}, ...extra };
}

const render = (c: any, r?: any, over: Record<string, any> = {}) => renderToolBlock(c, r, { width: WIDTH, ...over });
const head = (c: any, r?: any, over: Record<string, any> = {}) => render(c, r, over)[0];
const body = (c: any, r?: any, over: Record<string, any> = {}) => render(c, r, over).slice(1);
const plain = (lines: string[]) => lines.map(l => l.trim());

describe("resultText", () => {
  it("joins text parts and ignores non-text ones", () => {
    expect(resultText({ toolCallId: "c", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("is empty for a missing result", () => {
    expect(resultText(undefined)).toBe("");
  });
});

describe("indexToolResults", () => {
  it("pairs results by toolCallId and ignores other messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "one" }] },
      { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "two" }] },
    ];
    const index = indexToolResults(messages);
    expect([...index.keys()]).toEqual(["a", "b"]);
    expect(resultText(index.get("b"))).toBe("two");
  });
});

describe("paramLineCount", () => {
  it("counts a compact parameter set", () => {
    expect(paramLineCount({ path: "a.ts" })).toBe(3);
  });

  it("is zero for no parameters", () => {
    expect(paramLineCount({})).toBe(0);
    expect(paramLineCount(undefined)).toBe(0);
  });

  it("counts an embedded multi-line string as the lines it would render to", () => {
    // The trap: JSON.stringify escaping a script into one scalar hides its length.
    const script = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n");
    const raw = JSON.stringify({ code: script }, null, 2).split("\n").length;
    const expanded = paramLineCount({ code: script });

    expect(raw).toBe(3);
    expect(expanded).toBeGreaterThan(PARAMS_LINE_LIMIT);
  });
});

describe("built-in tool shapes", () => {
  it("read is a single line naming the file, its range and its line count", () => {
    const lines = render(call("read", { path: "src/auth.ts", offset: 1, limit: 120 }), result("c1", "x", { details: { truncation: { totalLines: 120 } } }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("✔ read src/auth.ts:1-120 · 120 lines");
  });

  it("read without a range names only the path", () => {
    const lines = render(call("read", { path: "src/auth.ts" }), result("c1", "a\nb\nc"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("✔ read src/auth.ts · 3 lines");
  });

  it("read shows the body only when expanded", () => {
    const r = result("c1", "first\nsecond\nthird");
    expect(body(call("read", { path: "a.ts" }), r)).toEqual([]);
    expect(plain(body(call("read", { path: "a.ts" }), r, { expanded: true }))).toEqual(["first", "second", "third"]);
  });

  it("edit leads with the file and replacement count, then the diff", () => {
    const diff = "  context\n- old\n+ new\n+ more";
    const r = result("c1", "Edited", { details: { diff } });
    const lines = render(call("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }), r);
    expect(lines[0]).toContain("✔ edit src/a.ts · 1 replacement");
    expect(plain(lines.slice(1))).toEqual(["context", "- old", "+ new", "+ more"]);
  });

  it("edit caps the diff while compact and marks what it dropped", () => {
    const diff = Array.from({ length: 20 }, (_, i) => `+ line ${i}`).join("\n");
    const lines = body(call("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }), result("c1", "", { details: { diff } }));
    expect(lines).toHaveLength(COMPACT_BODY_LINES);
    expect(lines[lines.length - 1]).toContain("more lines");
  });

  it("edit shows the whole diff when expanded", () => {
    const diff = Array.from({ length: 20 }, (_, i) => `+ line ${i}`).join("\n");
    const lines = body(call("edit", { path: "a.ts", edits: [] }), result("c1", "", { details: { diff } }), { expanded: true });
    expect(lines).toHaveLength(20);
  });

  it("bash leads with the complete command, not a truncated one", () => {
    const command = "npm test -- refresh --reporter=verbose --runInBand --silent";
    expect(head(call("bash", { command }), result("c1", "ok"))).toContain(`$ ${command}`);
  });

  it("bash shows the tail of its output, marking the earlier lines", () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const lines = body(call("bash", { command: "x" }), result("c1", output));
    expect(lines).toHaveLength(COMPACT_BODY_LINES);
    expect(lines[0]).toContain("earlier lines");
    expect(lines[lines.length - 1]).toContain("line 19");
  });

  it("bash shows live partial output while the tool is still running", () => {
    const lines = render(call("bash", { command: "sleep 5" }), undefined, { partial: "tick1\ntick2" });
    expect(lines[0].trimStart().startsWith("⟳")).toBe(true);
    expect(plain(lines.slice(1))).toEqual(["tick1", "tick2"]);
  });

  it("bash with no partial output yet is the head line alone", () => {
    expect(render(call("bash", { command: "sleep 5" }), undefined)).toHaveLength(1);
  });

  it("write shows the last line being written while it runs", () => {
    const content = "# Title\n\nfirst body line\nlast written line\n";
    const lines = render(call("write", { path: "docs/n.md", content }), undefined);
    expect(lines[0]).toContain("⟳ write docs/n.md · 5 lines");
    expect(plain(lines.slice(1))).toEqual(["⎿ last written line"]);
  });

  it("write reports the outcome once it finishes", () => {
    const lines = render(call("write", { path: "docs/n.md", content: "x" }), result("c1", "Wrote 42 bytes to docs/n.md"));
    expect(plain(lines.slice(1))).toEqual(["⎿ Wrote 42 bytes to docs/n.md"]);
  });

  it.each([
    ["grep", { pattern: "refreshToken", path: "src" }, 'grep "refreshToken" in src'],
    ["grep", { pattern: "a", glob: "*.ts" }, 'grep "a" --glob *.ts'],
    ["find", { pattern: "*.ts", path: "src" }, 'find "*.ts" in src'],
    ["ls", { path: "src/ui" }, "ls src/ui"],
  ])("%s inlines its parameters on one line", (name, args, expected) => {
    const lines = render(call(name, args), result("c1", "match 1\nmatch 2"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`✔ ${expected}`);
  });

  it("expansion reveals a search's matches", () => {
    const lines = body(call("grep", { pattern: "a", path: "src" }), result("c1", "match 1\nmatch 2"), { expanded: true });
    expect(plain(lines)).toEqual(["match 1", "match 2"]);
  });
});

describe("unshaped tools render their parameters", () => {
  it("shows parameters under the threshold in full", () => {
    const lines = render(call("custom_tool", { alpha: 1, beta: "two" }), result("c1", "ok"));
    expect(lines[0].trimEnd()).toBe("✔ custom_tool");
    expect(lines.join("\n")).toContain('"alpha": 1');
  });

  it("does not wrap the parameters in a second pair of braces", () => {
    // The parameters are a JSON object and arrive with their own braces; adding another pair
    // rendered them as two nested objects.
    const lines = plain(render(call("custom_tool", { alpha: 1 }), result("c1", "ok")));
    expect(lines.filter(l => l.trim() === "{")).toHaveLength(1);
    expect(lines.filter(l => l.trim() === "}")).toHaveLength(1);
  });

  it("folds parameters over the threshold and leaks none of them", () => {
    const script = Array.from({ length: 24 }, (_, i) => `await tools.bash({ command: 'echo ${i}' });`).join("\n");
    const lines = render(call("jun_code", { code: script }), result("c1", "ok"));
    expect(lines[0]).toContain(`✔ jun_code ${PARAMS_FOLDED}`);
    expect(lines.join("\n")).not.toContain("tools.bash");
  });

  it("expansion reveals the folded parameters", () => {
    const script = Array.from({ length: 24 }, (_, i) => `await tools.bash({ command: 'echo ${i}' });`).join("\n");
    const lines = render(call("jun_code", { code: script }), result("c1", "ok"), { expanded: true });
    expect(lines.join("\n")).toContain("tools.bash");
  });

  it("caps an expanded parameter set at the render-cost bound", () => {
    const script = Array.from({ length: FULL_BODY_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    const lines = body(call("jun_code", { code: script }), result("c1", "ok"), { expanded: true });
    expect(lines.length).toBeLessThanOrEqual(FULL_BODY_LINES + 2); // bound + closing brace + marker
  });

  it("a tool with no parameters is just its name", () => {
    expect(render(call("ping", {}), result("c1", "pong"))).toHaveLength(1);
    expect(head(call("ping", {}), result("c1", "pong"))).toContain("✔ ping");
  });
});

describe("marks", () => {
  it("marks a call with no result as still running", () => {
    expect(head(call("read", { path: "a.ts" }), undefined).trimStart().startsWith("⟳")).toBe(true);
  });

  it("says why a tool nobody shaped failed", () => {
    const failed = { toolCallId: "c1", toolName: "custom_tool", isError: true, content: [{ type: "text", text: "Error: no such endpoint" }], details: {} };
    const lines = render(call("custom_tool", { alpha: 1 }), failed);
    expect(lines[0].trimStart().startsWith("✘")).toBe(true);
    expect(plain(lines.slice(1))).toContain("✘ Error: no such endpoint");
  });

  it("does not say it twice when the tool output already is the error", () => {
    // A failed bash prints its error as its output; prefixing it again would read as two
    // different failures.
    const failed = { toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "Error: rg: bad flag" }], details: {} };
    const lines = plain(render(call("bash", { command: "rg --nope" }), failed));
    expect(lines.filter(l => l.includes("rg: bad flag"))).toHaveLength(1);
  });

  it("keeps the tool's own shape on failure", () => {
    const failed = { toolCallId: "c1", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }], details: {} };
    const lines = render(call("read", { path: "gone.ts" }), failed);
    expect(lines[0]).toContain("✘ read gone.ts");
    expect(plain(lines.slice(1))).toEqual(["✘ ENOENT"]);
  });
});

describe("width safety", () => {
  const longCall = call("bash", { command: `echo ${"x".repeat(300)}` });
  const longResult = result("c1", Array.from({ length: 10 }, () => "y".repeat(300)).join("\n"));

  it.each([40, 80, 120])("no line exceeds %i columns", (width) => {
    for (const expanded of [false, true]) {
      for (const line of renderToolBlock(longCall, longResult, { width, expanded })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("clips an overlong parameter line rather than letting the frame break", () => {
    const lines = render(call("jun_code", { code: `const a = "${"z".repeat(400)}";` }), result("c1", "ok"), { width: 40 });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("blockTint", () => {
  it("maps the three marks onto pi's tool-block backgrounds", () => {
    expect(blockTint(render(call("read", { path: "a.ts" }), undefined)[0])).toBe("toolPendingBg");
    expect(blockTint(render(call("read", { path: "a.ts" }), result("c1", "x"))[0])).toBe("toolSuccessBg");
    expect(blockTint(render(call("read", { path: "a.ts" }), { toolCallId: "c1", isError: true, content: [{ type: "text", text: "no" }] })[0])).toBe("toolErrorBg");
  });
});

