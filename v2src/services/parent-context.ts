import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Context } from "effect";

/**
 * parent-context.ts — the per-call view of the parent session.
 *
 * AgentTool builds one from the pi extension context and provides it for the duration of a
 * single Agent call; SessionFactory.live reads it instead of threading `ctx` below the tool.
 * Kept free of the extension-boundary type so services never couple to it.
 */

export interface ParentContextShape {
  readonly cwd: string;
  /** The parent's own session file, when the parent session is file-backed. */
  readonly sessionFile: string | undefined;
  readonly model: Model<Api> | undefined;
  readonly modelRegistry: ModelRegistry;
  /** The pi agents dir (getAgentDir()). */
  readonly agentDir: string;
}

export class ParentContext extends Context.Service<ParentContext, ParentContextShape>()(
  "pi-subagents/v2/ParentContext",
) {}
