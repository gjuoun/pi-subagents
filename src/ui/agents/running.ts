/**
 * running.ts — `/agents → Running agents`, and the conversation overlay behind it.
 *
 * The viewer is reached from two places — this list, and a fleet-list row through
 * `WorkflowMenuDeps.viewAgentConversation` — so it is exported and takes the context rather than
 * being written twice. Both entry points pass the same `VIEWER_OVERLAY` frame.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isTopLevelAgent } from "../../agent/agent-manager.js";
import type { AgentRecord } from "../../lib/types.js";
import { formatDuration } from "../../lib/ui/format.js";
import { getDisplayName } from "../agent-display.js";
import { selectItem } from "../select-item.js";
import type { AgentsUiDeps } from "./deps.js";

export async function showRunningAgents(ctx: ExtensionCommandContext, deps: AgentsUiDeps): Promise<void> {
  const agents = deps.context.manager.listAgents().filter(isTopLevelAgent);
  if (agents.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  // Numbered + item-paired. Two same-type agents spawned together with the
  // same description render identically here, and resolving the choice by
  // string match would open whichever came first.
  const record = await selectItem(ctx.ui, "Running agents", agents, a => {
    const dn = getDisplayName(a.type);
    const dur = formatDuration(a.startedAt, a.completedAt);
    return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
  });
  if (!record) return;

  await viewAgentConversation(ctx, record, deps);
  // Back-navigation: re-show the list
  await showRunningAgents(ctx, deps);
}

export async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord, deps: AgentsUiDeps): Promise<void> {
  if (!record.session) {
    ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
    return;
  }

  const { ConversationViewer, VIEWER_OVERLAY } = await import("../viewer/conversation-viewer.js");
  const session = record.session;
  const activity = deps.context.agentActivity.get(record.id);

  await ctx.ui.custom<undefined>(
    (tui, theme, keybindings, done) => {
      return new ConversationViewer(tui, session, record, activity, theme, done, () => {
        if (deps.context.manager.abort(record.id)) {
          ctx.ui.notify(`Stopped "${record.description}".`, "info");
        }
      }, keybindings, (message: string) => deps.context.manager.steer(record.id, message), () => deps.context.getViewerMarkdown());
    },
    // One shared frame for every entry point — see VIEWER_OVERLAY.
    { ...VIEWER_OVERLAY },
  );
}
