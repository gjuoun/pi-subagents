/**
 * index.ts — the v2 extension entry (JG-117 core rewrite).
 *
 * Loadable only via an explicit path until a later issue repoints the manifest:
 * pi -ne -e ./src/index.ts. Answers to the canonical token "src".
 */

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Effect, Result, Stream } from "effect";
import type { AgentSnapshot } from "./domain/agent.js";
import { renderError } from "./domain/errors.js";
import { SUBAGENT_RESULT_TYPE, SubagentResultMessage } from "./domain/subagent-result.js";
import { type AppOverrides, type AppRuntime, makeRuntime } from "./layers.js";
import { AgentTool } from "./pi/agent-tool.js";
import { registerAgentsCommand } from "./pi/agents-command.js";
import { GetResultTool } from "./pi/get-result-tool.js";
import { installMentionHook, mentionRoster } from "./pi/mention-hook.js";
import { isChildContext } from "./pi/pi-child-session.js";
import { SteerTool } from "./pi/steer-tool.js";
import { AgentRegistry } from "./services/agent-registry.js";
import { agentBadge } from "./ui/agent-color.js";
import { renderAgentCall, renderAgentResult } from "./ui/agent-tool-view.js";
import { FleetView } from "./ui/fleet-view.js";
import { createMentionProvider } from "./ui/mention-completion.js";
import { ResultMessageView } from "./ui/result-message-view.js";
import { ConversationViewer, VIEWER_OVERLAY } from "./ui/viewer/conversation-viewer.js";

/**
 * V2Extension wires the tool, the result renderer and the session lifecycle against one pi
 * instance. Exported (not just the default) so a test can hold the runtime and drive the
 * lifecycle handlers a mock pi recorded.
 */
export class V2Extension {
  readonly #pi: ExtensionAPI;
  /** Test seam: a layer merged over the default deps so a test swaps SessionFactory etc. */
  readonly #overrides: AppOverrides | undefined;
  #runtime: AppRuntime | undefined;
  /** The latest registry snapshots, pushed by the runtime; the FleetView reads them. */
  #snapshots: ReadonlyArray<AgentSnapshot> = [];
  #fleet: FleetView | undefined;

  constructor(pi: ExtensionAPI, overrides?: AppOverrides) {
    this.#pi = pi;
    this.#overrides = overrides;
  }

  register(): void {
    this.#pi.registerTool(
      new AgentTool(() => this.#ensure(), { renderCall: renderAgentCall, renderResult: renderAgentResult }, this.#pi)
        .definition,
    );
    this.#pi.registerTool(new GetResultTool(() => this.#ensure()).definition);
    this.#pi.registerTool(new SteerTool(() => this.#ensure()).definition);
    installMentionHook(this.#pi, () => this.#runtime);
    registerAgentsCommand(this.#pi, () => this.#runtime, (ctx, id) => this.openViewer(ctx, id));

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
    if (this.#runtime === undefined) this.#runtime = makeRuntime(this.#pi, this.#overrides);
    return this.#runtime;
  }

  #onSessionStart(_event: unknown, ctx: ExtensionContext): void {
    if (this.#runtime === undefined) this.#runtime = makeRuntime(this.#pi, this.#overrides);
    if (ctx.hasUI) {
      const fleet = new FleetView(
        () => this.#snapshots,
        (id) => this.openViewer(ctx, id),
        {
          renderName: (s, theme, selected) =>
            agentBadge(s.name, s.color, selected) ?? theme.fg(selected ? "text" : "muted", s.name),
        },
      );
      this.#fleet = fleet;
      fleet.attach(ctx.ui);
      // Keep the list's view of the registry current; it dies with the runtime.
      this.#runtime.runFork(
        Effect.gen({ self: this }, function* () {
          const registry = yield* AgentRegistry;
          yield* Stream.runForEach(registry.changes, (snapshots) =>
            Effect.sync(() => {
              this.#snapshots = snapshots;
              fleet.refresh();
            }),
          );
        }),
      );
      // Stack the `@` agent rows on pi's own autocomplete for this session's UI.
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionProvider(current, async () => {
          const runtime = this.#runtime;
          return runtime === undefined ? { live: [], types: [] } : mentionRoster(runtime, ctx);
        }),
      );
    }
  }

  /** Open the live conversation overlay for agent `id`; resolves when it closes. */
  async openViewer(ctx: ExtensionContext, id: string): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const agent = await runtime.runPromise(Effect.flatMap(AgentRegistry, (r) => r.find(id)));
    const markdown = piMarkdownTheme();
    await ctx.ui.custom<undefined>(
      (tui, theme, _keys, done) =>
        new ConversationViewer(
          tui,
          {
            snapshot: () => this.#snapshots.find((s) => s.id === id),
            messages: () => agent.session.messages(),
            onChange: (listener) => agent.session.onChange(listener),
            steer: (message) =>
              runtime
                .runPromise(Effect.result(agent.steer(message)))
                .then((r) =>
                  Result.isSuccess(r) ? (r.success === "sent" ? "Steer sent." : "Queued with the prompt.") : renderError(r.failure),
                ),
            stop: () => void runtime.runPromise(agent.abort()),
          },
          theme,
          () => done(undefined),
          markdown,
        ),
      { ...VIEWER_OVERLAY },
    );
  }

  #onSessionShutdown(): Promise<void> | undefined {
    this.#fleet?.dispose();
    this.#fleet = undefined;
    this.#snapshots = [];
    const previous = this.#runtime;
    this.#runtime = undefined;
    return previous?.dispose();
  }
}

/**
 * pi's Markdown theme when this process has one. It reads pi's global theme lazily, so it is
 * probed once: an uninitialised theme (tests, embedded sessions) falls back to plain text.
 */
function piMarkdownTheme(): MarkdownTheme | undefined {
  try {
    const theme = getMarkdownTheme();
    theme.heading("probe");
    return theme;
  } catch {
    return undefined;
  }
}

export default function v2Extension(pi: ExtensionAPI): void {
  // A child session loads the same extensions; re-entering would nest a runtime.
  if (isChildContext()) return;
  new V2Extension(pi).register();
}
