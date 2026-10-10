import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "./agent.js";
import type { PiOutboundMessage } from "./pi-host.js";

/**
 * subagent-result-message.ts — the one value class for a subagent-result message.
 *
 * It owns the message both ways: fromAgent builds content + plain details for delivery, fromPi
 * decodes a pi message for the renderer, toOutbound is the pi message, and render is today's
 * collapsed/expanded display logic (display only — the LLM still receives the full content).
 */

export const SUBAGENT_RESULT_TYPE = "subagent-result";

const SHOWN_LINES = 3;

export interface SubagentResultDetails {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly description: string;
  readonly durationMs: number;
  readonly toolUses: number;
}

export interface RenderResultOptions {
  readonly expanded: boolean;
  readonly width: number;
}

/** The shape pi hands a message renderer. */
export interface PiMessageLike {
  readonly content?: unknown;
  readonly details?: unknown;
}

export class SubagentResultMessage {
  readonly details: SubagentResultDetails | undefined;
  readonly content: string;

  private constructor(details: SubagentResultDetails | undefined, content: string) {
    this.details = details;
    this.content = content;
  }

  /** Build the message a settled foreground/background run delivers. */
  static fromAgent(snapshot: AgentSnapshot, status: "done" | "error", body: string): SubagentResultMessage {
    const details: SubagentResultDetails = {
      id: snapshot.id,
      name: snapshot.name,
      type: snapshot.type,
      status,
      description: snapshot.description,
      durationMs: Date.now() - snapshot.startedAt,
      toolUses: snapshot.toolUses,
    };
    const content = `${snapshot.name} · ${status} · ${snapshot.description}\n\n${body}`;
    return new SubagentResultMessage(details, content);
  }

  /** Decode a pi message for the renderer. */
  static fromPi(message: PiMessageLike): SubagentResultMessage {
    return new SubagentResultMessage(
      message.details as SubagentResultDetails | undefined,
      typeof message.content === "string" ? message.content : "",
    );
  }

  /** The plain pi message this class delivers. */
  toOutbound(): PiOutboundMessage {
    return { customType: SUBAGENT_RESULT_TYPE, content: this.content, display: true, details: this.details };
  }

  /** Collapsed/expanded display lines, each truncated to the available width. */
  render(options: RenderResultOptions): string[] {
    const head = statusLine(this.details);
    const body = this.content.split("\n");
    const lines = options.expanded ? [head, ...body] : collapse(head, body);
    return lines.map((line) => truncateToWidth(line, options.width));
  }

  /** The one-glyph status marker shared by the result message and the widget. */
  static statusGlyph(status: string): string {
    switch (status) {
      case "done":
        return "✓";
      case "error":
        return "✗";
      case "aborted":
        return "■";
      default:
        return "·";
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusLine(details: SubagentResultDetails | undefined): string {
  if (details === undefined) return "✓ subagent";
  return `${SubagentResultMessage.statusGlyph(details.status)} ${details.name} · ${details.description} · ${details.toolUses} tools · ${formatDuration(details.durationMs)}`;
}

function collapse(head: string, body: readonly string[]): string[] {
  if (body.length <= SHOWN_LINES + 1) return [head, ...body];
  // The three shown lines plus the status line occupy four rows; the rest are hidden.
  const hidden = body.length - SHOWN_LINES - 1;
  return [head, ...body.slice(0, SHOWN_LINES), `… ${hidden} more lines`];
}
