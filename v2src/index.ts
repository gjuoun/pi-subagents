/**
 * index.ts — the v2 extension entry (JG-117 core rewrite).
 *
 * Loadable only via an explicit path until a later issue repoints the manifest:
 * pi -ne -e ./v2src/index.ts. Answers to the canonical token "v2src".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RESULT_TYPE, type SubagentResultDetails } from "./notify.js";
import { type AppRuntime, makeRuntime } from "./runtime.js";
import { inChildSessionContext } from "./spawn.js";
import { createAgentTool } from "./tool.js";
import { renderResultMessage } from "./ui/result-message.js";
import { installWidget } from "./ui/widget.js";

export interface V2ExtensionHandle {
  /** The current runtime, or undefined between shutdown and the next session_start. */
  getRuntime: () => AppRuntime | undefined;
  dispose: () => Promise<void>;
}

/**
 * Wire the extension. Exported (not just the default) so a test can hold the runtime and
 * drive the lifecycle handlers a mock pi recorded.
 */
export function createV2Extension(pi: ExtensionAPI): V2ExtensionHandle {
  let runtime: AppRuntime | undefined;
  const ensure = (): AppRuntime => (runtime ??= makeRuntime(pi));

  pi.registerTool(createAgentTool(ensure));

  // Display-only renderer for the background result message.
  pi.registerMessageRenderer(SUBAGENT_RESULT_TYPE, (message, options) => ({
    render: (width: number) =>
      renderResultMessage(
        message.details as SubagentResultDetails | undefined,
        typeof message.content === "string" ? message.content : "",
        { expanded: options.expanded, width },
      ),
    invalidate: () => {},
  }));

  // A fresh runtime per session: children die with the parent session (their runtime is
  // disposed), and the next session starts clean.
  pi.on("session_start", (_event, ctx) => {
    if (runtime === undefined) runtime = makeRuntime(pi);
    if (ctx.hasUI) installWidget(runtime, ctx.ui);
  });
  pi.on("session_shutdown", () => {
    const previous = runtime;
    runtime = undefined;
    return previous?.dispose();
  });

  return {
    getRuntime: () => runtime,
    dispose: async () => {
      const previous = runtime;
      runtime = undefined;
      await previous?.dispose();
    },
  };
}

export default function v2Extension(pi: ExtensionAPI): void {
  // A child session loads the same extensions; re-entering would nest a runtime.
  if (inChildSessionContext()) return;
  createV2Extension(pi);
}
