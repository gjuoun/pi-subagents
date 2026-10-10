import type { AgentSnapshot } from "./agent.js";

/**
 * subagent-result.ts — the one value class for a subagent-result message.
 *
 * It owns the message both ways: fromAgent builds content + plain details for delivery,
 * fromPlain decodes a pi message for the renderer (see ui/result-message-view.ts), and
 * toOutbound is the plain pi message. Rendering lives in the ui layer.
 */

export const SUBAGENT_RESULT_TYPE = "subagent-result";

export interface SubagentResultDetails {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly description: string;
  readonly durationMs: number;
  readonly toolUses: number;
}

/** The shape pi hands a message renderer. */
export interface PlainMessageLike {
  readonly content?: unknown;
  readonly details?: unknown;
}

/** A plain message to push into the parent conversation. */
export interface PiOutboundMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
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
  static fromPlain(message: PlainMessageLike): SubagentResultMessage {
    return new SubagentResultMessage(
      message.details as SubagentResultDetails | undefined,
      typeof message.content === "string" ? message.content : "",
    );
  }

  /** The plain pi message this class delivers. */
  toOutbound(): PiOutboundMessage {
    return { customType: SUBAGENT_RESULT_TYPE, content: this.content, display: true, details: this.details };
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
