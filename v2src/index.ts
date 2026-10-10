/**
 * index.ts — the v2 extension entry (JG-117 core rewrite).
 *
 * Loadable only via an explicit path until a later issue repoints the manifest:
 * pi -ne -e ./v2src/index.ts. Answers to the canonical token "v2src".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Layer } from "effect";
import { SUBAGENT_RESULT_TYPE, SubagentResultMessage } from "./domain/subagent-result.js";
import { type AppRuntime, makeRuntime } from "./layers.js";
import { AgentTool } from "./pi/agent-tool.js";
import { isChildContext } from "./pi/pi-child-session.js";
import type { SessionFactory } from "./services/session-factory.js";
import { AgentWidget } from "./ui/agent-widget.js";
import { ResultMessageView } from "./ui/result-message-view.js";

/**
 * V2Extension wires the tool, the result renderer and the session lifecycle against one pi
 * instance. Exported (not just the default) so a test can hold the runtime and drive the
 * lifecycle handlers a mock pi recorded.
 */
export class V2Extension {
  readonly #pi: ExtensionAPI;
  /** Test seam: a stub SessionFactory the runtime is built with instead of the live one. */
  readonly #sessionFactory: Layer.Layer<SessionFactory> | undefined;
  #runtime: AppRuntime | undefined;

  constructor(pi: ExtensionAPI, sessionFactory?: Layer.Layer<SessionFactory>) {
    this.#pi = pi;
    this.#sessionFactory = sessionFactory;
  }

  register(): void {
    this.#pi.registerTool(new AgentTool(() => this.#ensure()).definition);

    // Display-only renderer for the background result message.
    this.#pi.registerMessageRenderer(SUBAGENT_RESULT_TYPE, (message, options) => ({
      render: (width: number) =>
        ResultMessageView.render(SubagentResultMessage.fromPlain(message), { expanded: options.expanded, width }),
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
    if (this.#runtime === undefined) this.#runtime = makeRuntime(this.#pi, {}, this.#sessionFactory);
    return this.#runtime;
  }

  #onSessionStart(_event: unknown, ctx: ExtensionContext): void {
    if (this.#runtime === undefined) this.#runtime = makeRuntime(this.#pi, {}, this.#sessionFactory);
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
  if (isChildContext()) return;
  new V2Extension(pi).register();
}
