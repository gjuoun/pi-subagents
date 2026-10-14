import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { MentionRoster } from "../domain/mention.js";
import { transformMention } from "../domain/mention.js";
import type { AppRuntime } from "../layers.js";
import { AgentRegistry } from "../services/agent-registry.js";
import { AgentTypeCatalog } from "../services/agent-type-catalog.js";
import { ParentContext } from "../services/parent-context.service.js";
import { parentContextFromExtension } from "./agent-tool.js";

/**
 * mention-hook.ts — the pi wiring for `@handle` (JW-166): the input hook that appends the
 * Claude Code reminder, and the `@` completion provider. Nothing is dispatched directly — the
 * main model reads the reminder and makes the tool call.
 */

/** Live agents and enabled types, as the mention grammar sees them. */
export function mentionRoster(runtime: AppRuntime, ctx: ExtensionContext): Promise<MentionRoster> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const catalog = yield* AgentTypeCatalog;
      const live = (yield* registry.snapshots).map((s) => ({
        id: s.id,
        handle: s.handle,
        type: s.type,
        status: s.status,
        description: s.description,
      }));
      const types = (yield* catalog.list()).map((t) => ({ name: t.name, description: t.description }));
      return { live, types };
    }).pipe(Effect.provideService(ParentContext, parentContextFromExtension(ctx))),
  );
}

/** Install the input hook; the `@` completion provider is wired per session in index.ts (pi/ may not import ui/). */
export function installMentionHook(pi: ExtensionAPI, getRuntime: () => AppRuntime | undefined): void {
  pi.on("input", async (event, ctx) => {
    // Only what a person typed: text the extension layer submitted is never a mention.
    if (event.source === "extension") return { action: "continue" };
    const runtime = getRuntime();
    if (runtime === undefined || !event.text.startsWith("@")) return { action: "continue" };
    const text = transformMention(event.text, await mentionRoster(runtime, ctx));
    if (text === undefined) return { action: "continue" };
    return { action: "transform", text, ...(event.images && { images: event.images }) };
  });
}
