/**
 * viewer-blocks.ts — the conversation viewer's tool-block model.
 *
 * A tool call and its result are one block, shaped by the tool: `read` collapses to a
 * single line naming the file and its line count, `edit` shows the changed lines, `bash`
 * shows the complete command with its output, `write` shows what is being written, and a
 * tool nobody wrote a shape for shows its parameters — or `{ ... }` when those parameters
 * are longer than any reader wants to see by default.
 *
 * Everything here is pure: messages in, lines out. The viewer owns the chrome (border,
 * header, footer, scrolling) and the Markdown machinery for assistant prose; this module
 * owns what a tool call looks like, so the shape can be unit-tested without a terminal.
 *
 * `expanded` (the viewer's `e`) lifts the built-in bodies and the parameter threshold.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";


/** Structural subset of a pi `ToolCall` — what this module needs from an assistant message. */
export interface ViewerToolCall {
  id: string;
  name: string;
  arguments?: Record<string, any>;
}

/** Structural subset of a pi `ToolResultMessage`. */
export interface ViewerToolResult {
  toolCallId: string;
  toolName?: string;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  details?: any;
}

export interface BlockOptions {
  width: number;
  /** The viewer's `e` — reveals full bodies and parameters. */
  expanded?: boolean;
  /** Live partial output for a running tool, from `tool_execution_update`. */
  partial?: string;
}

/** What a hidden parameter set collapses to. */
export const PARAMS_FOLDED = "{ ... }";

/**
 * Rendered-line limit for a non-built-in tool's parameters, above which they are hidden.
 *
 * Counted with embedded newlines *expanded* — see `paramLineCount`.
 */
export const PARAMS_LINE_LIMIT = 20;

/** Body lines a built-in tool gets while compact. */
export const COMPACT_BODY_LINES = 6;

/** Body lines a block gets at most once expanded, in either direction — a render-cost bound. */
export const FULL_BODY_LINES = 200;

/** Indent applied to every body line, so a block's head reads as its title. */
const BODY_INDENT = "  ";


/** The text of a tool result, or "" when it carries none (images, empty results). */
export function resultText(result: ViewerToolResult | undefined): string {
  if (!result?.content) return "";
  return result.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("\n")
    .trim();
}

/** Index every tool result in a transcript by the call it answers. */
export function indexToolResults(messages: readonly any[]): Map<string, ViewerToolResult> {
  const byCall = new Map<string, ViewerToolResult>();
  for (const msg of messages) {
    if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
      byCall.set(msg.toolCallId, msg as ViewerToolResult);
    }
  }
  return byCall;
}

/**
 * How many lines a parameter set would render to, with embedded newlines expanded.
 *
 * This is the number the fold threshold is compared against, and it has to be this one:
 * a `jun_code` call carrying a 24-line script stringifies to three lines (the script is a
 * single escaped scalar), so counting raw JSON would let exactly the calls the rule exists
 * for sail under the limit.
 */
export function paramLineCount(args: Record<string, any> | undefined): number {
  if (!args || Object.keys(args).length === 0) return 0;
  const pretty = JSON.stringify(args, null, 2) ?? "";
  // Every embedded newline in a string value renders as its own line, so it has to be
  // counted as one — otherwise the length of a script is invisible to the threshold.
  const embeddedNewlines = (value: any): number => {
    if (typeof value === "string") return value.split("\n").length - 1;
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + embeddedNewlines(item), 0);
    if (value && typeof value === "object") return Object.values(value).reduce<number>((sum, item) => sum + embeddedNewlines(item), 0);
    return 0;
  };
  return pretty.split("\n").length + embeddedNewlines(args);
}

/** Lines a tool result contributes, without rendering it. */
function resultLineCount(result: ViewerToolResult | undefined): number {
  const text = resultText(result);
  return text ? text.split("\n").length : 0;
}


/** `✔` ok · `✘` failed · `⟳` still running. */
function mark(result: ViewerToolResult | undefined): string {
  if (!result) return "⟳";
  return result.isError ? "✘" : "✔";
}

/** `<path>` with a `:offset-end` range when the call asked for one. */
function pathWithRange(args: Record<string, any> | undefined): string {
  const path = typeof args?.path === "string" ? args.path : "?";
  if (typeof args?.offset !== "number") return path;
  const end = typeof args?.limit === "number" ? args.offset + args.limit - 1 : undefined;
  return `${path}:${args.offset}${end === undefined ? "+" : `-${end}`}`;
}

/** The one-line head for a tool, before the mark is applied. */
function headFor(call: ViewerToolCall, result: ViewerToolResult | undefined, expanded: boolean): string {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "read": {
      const total = result?.details?.truncation?.totalLines ?? resultLineCount(result);
      const suffix = total > 0 ? ` · ${total} lines` : "";
      return `read ${pathWithRange(args)}${suffix}`;
    }
    case "edit": {
      const count = Array.isArray(args.edits) ? args.edits.length : 0;
      return `edit ${typeof args.path === "string" ? args.path : "?"} · ${count} replacement${count === 1 ? "" : "s"}`;
    }
    case "bash":
      return `$ ${typeof args.command === "string" ? args.command : "?"}`;
    case "write": {
      const lines = typeof args.content === "string" ? args.content.split("\n").length : 0;
      return `write ${typeof args.path === "string" ? args.path : "?"} · ${lines} lines`;
    }
    case "grep": {
      const where = typeof args.path === "string" ? ` in ${args.path}` : "";
      const glob = typeof args.glob === "string" ? ` --glob ${args.glob}` : "";
      return `grep ${JSON.stringify(args.pattern ?? "?")}${glob}${where}`;
    }
    case "find": {
      const where = typeof args.path === "string" ? ` in ${args.path}` : "";
      return `find ${JSON.stringify(args.pattern ?? "?")}${where}`;
    }
    case "ls":
      return `ls ${typeof args.path === "string" ? args.path : "."}`;
    default: {
      // The parameters are a JSON object and already carry their own braces; wrapping them in
      // a second pair read as two nested objects.
      const count = paramLineCount(args);
      if (count === 0) return call.name;
      if (!expanded && count > PARAMS_LINE_LIMIT) return `${call.name} ${PARAMS_FOLDED}`;
      return call.name;
    }
  }
}

/** The lines under a block's head, already indented and clipped to `width`. */
function bodyFor(call: ViewerToolCall, result: ViewerToolResult | undefined, options: BlockOptions): string[] {
  const { width, expanded = false, partial } = options;
  const args = call.arguments ?? {};
  const cap = expanded ? FULL_BODY_LINES : COMPACT_BODY_LINES;
  const running = result === undefined;

  const lines: string[] = [];

  switch (call.name) {
    case "read":
      // One line by default; the file's contents only earn their space when expanded.
      if (expanded) lines.push(...take(resultText(result).split("\n"), cap, false));
      break;


    case "edit": {
      const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
      if (diff) lines.push(...take(diff.split("\n"), cap, false));
      break;
    }

    case "bash": {
      // A running command shows what has arrived so far; a finished one shows the tail,
      // which is where a test run says whether it passed. Expanded, the tail is simply a
      // longer tail — the verdict is still at the end, never in the first 200 lines.
      const text = running ? (partial ?? "") : resultText(result);
      if (text) lines.push(...take(text.split("\n"), cap, true));
      break;
    }

    case "write": {
      if (running) {
        // No partial results exist for `write` (it never calls onUpdate), so the line being
        // written is read from the call's own arguments, which are in the transcript first.
        const content = typeof args.content === "string" ? args.content : "";
        const last = content.split("\n").filter(line => line.trim()).pop();
        if (last) lines.push(`⎿ ${last.trim()}`);
      } else {
        const done = resultText(result) || `wrote ${typeof args.content === "string" ? args.content.length : 0} bytes`;
        lines.push(`⎿ ${done}`);
      }
      break;
    }

    case "grep":
    case "find":
    case "ls":
      // The head already carries the parameters; the matches are what expansion is for.
      if (expanded) lines.push(...take(resultText(result).split("\n"), cap, false));
      break;

    default: {
      const count = paramLineCount(args);
      const folded = !expanded && count > PARAMS_LINE_LIMIT;
      if (count > 0 && !folded) {
        lines.push(...take(JSON.stringify(args, null, 2).split("\n"), expanded ? FULL_BODY_LINES : PARAMS_LINE_LIMIT, false));
      }
      if (expanded) lines.push(...take(resultText(result).split("\n"), cap, false));
      break;
    }
  }

  // A failure says why, on every tool, regardless of the shape above — unless the tool's own
  // body already carried the message (a `bash` failure prints its error as its output).
  if (result?.isError) {
    const error = resultText(result).split("\n")[0] ?? "";
    if (error && !lines.some(line => line.includes(error))) lines.push(`✘ ${error}`);
  }

  return lines
    .map(line => truncateToWidth(BODY_INDENT + line, Math.max(0, width)));
}

/**
 * Take at most `max` lines, from the head or the tail, reporting what was dropped.
 *
 * Which end is the caller's choice, and it tracks the two reading modes: compact wants the
 * tail (what just happened, how the command ended) while an expanded body wants the head,
 * because the reader asked to read it and nobody reads a file backwards.
 *
 * The count is what keeps this honest: the point of the fold is lost if a reader cannot
 * tell that something was cut, and the harness asserts the marker rather than the absence.
 */
function take(lines: string[], max: number, tail: boolean): string[] {
  const meaningful = lines.filter((line, i) => !(i === lines.length - 1 && line === ""));
  if (meaningful.length <= max) return meaningful;
  // The marker costs a line of its own either way: the cap is the block's, not the content's,
  // or a "6-line" body would render as 7.
  if (tail) {
    return [`⋯ ${meaningful.length - (max - 1)} earlier lines`, ...meaningful.slice(-(max - 1))];
  }
  return [...meaningful.slice(0, max - 1), `⋯ +${meaningful.length - max + 1} more lines`];
}

/**
 * A tool call as the viewer draws it: a head line and its body lines.
 *
 * The head is always one line, already clipped to `width`, so callers can treat
 * `lines[0]` as the block's identity when asserting or navigating.
 */
export function renderToolBlock(call: ViewerToolCall, result: ViewerToolResult | undefined, options: BlockOptions): string[] {
  const { width, expanded = false } = options;
  const head = `${mark(result)} ${headFor(call, result, expanded)}`;
  return [truncateToWidth(head, Math.max(0, width)), ...bodyFor(call, result, options)];
}

/**
 * The background a block's head takes, following pi's own tool-block tints.
 *
 * Lives here because the marks do: the viewer can paint the tint but must not have to
 * re-derive what `⟳`/`✔`/`✘` mean in order to do it.
 */
export function blockTint(head: string): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
  const mark = head.trimStart()[0];
  if (mark === "✘") return "toolErrorBg";
  return mark === "⟳" ? "toolPendingBg" : "toolSuccessBg";
}

/**
 * A tool result whose call is no longer in the transcript — a compacted-away assistant turn,
 * or a resumed session that began mid-run.
 *
 * It gets a block like any other call, named by the tool and showing its output: dropping it
 * would silently lose work the agent did, which is the failure mode this whole view exists
 * to prevent.
 */
export function renderResultBlock(toolName: string, result: ViewerToolResult | undefined, options: BlockOptions): string[] {
  const { width, expanded = false } = options;
  const cap = expanded ? FULL_BODY_LINES : COMPACT_BODY_LINES;
  const text = resultText(result);
  // Unknown content: compact takes the tail, expanded starts at the top.
  const lines = text ? take(text.split("\n"), cap, !expanded) : [];
  if (result?.isError) {
    const error = text.split("\n")[0] ?? "";
    if (error && !lines.some(line => line.includes(error))) lines.push(`✘ ${error}`);
  }
  return [
    truncateToWidth(`${mark(result)} ${toolName}`, Math.max(0, width)),
    ...lines.map(line => truncateToWidth(BODY_INDENT + line, Math.max(0, width))),
  ];
}

/** Visible width of a rendered line — re-exported so the viewer's width tests share one ruler. */
export { visibleWidth };
