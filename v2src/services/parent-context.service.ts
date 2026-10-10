import type { Api, Model } from "@earendil-works/pi-ai";
import { Context } from "effect";

/**
 * parent-context.service.ts — the per-call view of the parent session.
 *
 * AgentTool builds one from the pi extension context and provides it for the duration of a
 * single Agent call; SessionFactory.live reads it instead of threading `ctx` below the tool.
 * The shape is structural so services never import the pi-coding-agent runtime types.
 */

/** The slice of the pi model registry v2 uses. */
export interface ParentModelRegistry {
  find?(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ParentContextShape {
  readonly cwd: string;
  /** The parent's own session file, when the parent session is file-backed. */
  readonly sessionFile: string | undefined;
  readonly model: Model<Api> | undefined;
  readonly modelRegistry: ParentModelRegistry;
  /** The pi agents dir (getAgentDir()). */
  readonly agentDir: string;
}

export class ParentContext extends Context.Service<ParentContext, ParentContextShape>()(
  "pi-subagents/v2/ParentContext",
) {}
