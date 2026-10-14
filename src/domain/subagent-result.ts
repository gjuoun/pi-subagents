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
  readonly turns?: number;
  readonly model?: string;
  readonly thinking?: string;
  readonly tokens?: number;
  readonly contextPercent?: number;
  /** Set on a grouped message: one entry per agent it carries, this one first. */
  readonly group?: ReadonlyArray<SubagentResultDetails>;
  /** A grouped message delivered before every agent of the group finished. */
  readonly partial?: boolean;
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
  static fromAgent(snapshot: AgentSnapshot, status: "done" | "error" | "aborted", body: string): SubagentResultMessage {
    const details: SubagentResultDetails = {
      id: snapshot.id,
      name: snapshot.name,
      type: snapshot.type,
      status,
      description: snapshot.description,
      durationMs: (snapshot.finishedAt ?? snapshot.startedAt) - snapshot.startedAt,
      toolUses: snapshot.toolUses,
      turns: snapshot.turns,
      model: snapshot.model,
      thinking: snapshot.thinking,
      tokens: snapshot.tokens,
      contextPercent: snapshot.contextPercent,
    };
    const content = `${snapshot.name} · ${status} · ${snapshot.description}\n\n${body}`;
    return new SubagentResultMessage(details, content);
  }

  /**
   * One message for a group of background agents started together (the smart join). The
   * details are the first agent's plus `group` listing every agent.
   */
  static group(items: ReadonlyArray<SubagentResultMessage>, partial: boolean): SubagentResultMessage {
    const label = `${items.length} agent(s) finished${partial ? " (partial — others still running)" : ""}`;
    const content = `Background agent group completed: ${label}\n\n${items.map((m) => m.content).join("\n\n---\n\n")}`;
    const all = items.map((m) => m.details).filter((d): d is SubagentResultDetails => d !== undefined);
    const details = all[0] === undefined ? undefined : { ...all[0], group: all, partial };
    return new SubagentResultMessage(details, content);
  }

  /** The agent ids this message reports on. */
  get agentIds(): ReadonlyArray<string> {
    if (this.details === undefined) return [];
    return this.details.group?.map((d) => d.id) ?? [this.details.id];
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
