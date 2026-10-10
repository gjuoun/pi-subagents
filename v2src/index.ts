/**
 * index.ts — the v2 extension entry (JG-117 core rewrite).
 *
 * Loadable only via an explicit path until a later issue repoints the manifest:
 * pi -ne -e ./v2src/index.ts. Answers to the canonical token "v2src".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentTool } from "./agent-tool.js";
import { ChildSession } from "./child-session.js";
import { type AppRuntime, makeRuntime } from "./runtime.js";
import { SUBAGENT_RESULT_TYPE, SubagentResultMessage } from "./subagent-result-message.js";
import { AgentWidget } from "./ui/agent-widget.js";

/**
 * V2Extension wires the tool, the result renderer and the session lifecycle against one pi
 * instance. Exported (not just the default) so a test can hold the runtime and drive the
 * lifecycle handlers a mock pi recorded.
 */
export class V2Extension {
  readonly #pi: ExtensionAPI;
  #runtime: AppRuntime | undefined;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  register(): void {
    this.#pi.registerTool(new AgentTool(() => this.#ensure()).definition);

    // Display-only renderer for the background result message.
    this.#pi.registerMessageRenderer(SUBAGENT_RESULT_TYPE, (message, options) => ({
      render: (width: number) => SubagentResultMessage.fromPi(message).render({ expanded: options.expanded, width }),
      invalidate: () => {},
    }));

    // A fresh runtime per session: children die with the parent session (their runtime is
    // disposed), and the next session starts clean.
    this.#pi.on("session_start", (event, ctx) => this.#onSessionStart(event, ctx));
    this.#pi.on("session_shutdown", () => this.#onSessionShutdown());
  }

  /** The current runtime, or undefined between shutdown and the next session_start. */
  get runtime(): AppRuntime | undefined {
    return this.#runtime;
  }

  async dispose(): Promise<void> {
    const previous = this.#runtime;
    this.#runtime = undefined;
    await previous?.dispose();
  }

  #ensure(): AppRuntime {
    if (this.#runtime === undefined) this.#runtime = makeRuntime(this.#pi);
    return this.#runtime;
  }

  #onSessionStart(_event: unknown, ctx: ExtensionContext): void {
    if (this.#runtime === undefined) this.#runtime = makeRuntime(this.#pi);
    if (ctx.hasUI) this.#runtime.runFork(new AgentWidget(ctx.ui).run);
  }

  #onSessionShutdown(): Promise<void> | undefined {
    const previous = this.#runtime;
    this.#runtime = undefined;
    return previous?.dispose();
  }
}

export default function v2Extension(pi: ExtensionAPI): void {
  // A child session loads the same extensions; re-entering would nest a runtime.
  if (ChildSession.isChildContext()) return;
  new V2Extension(pi).register();
}
