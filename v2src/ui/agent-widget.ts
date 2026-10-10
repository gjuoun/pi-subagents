import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Effect, Stream } from "effect";
import type { AgentSnapshot } from "../domain/agent.js";
import { SubagentResultMessage } from "../domain/subagent-result.js";
import { AgentRegistry } from "../services/agent-registry.js";

/**
 * agent-widget.ts — the pure widget renderer plus its thin pi wiring.
 *
 * One line per running agent, then agents that finished in the last few seconds; capped,
 * with a "+N more" tail. Lines are truncated to the pane width. run is an Effect requiring
 * AgentRegistry that repaints on every change and on a 1s clock; it dies with the runtime on
 * session_shutdown.
 */

export const WIDGET_KEY = "pi-subagents-v2";
const LIMIT = 5;
const RECENT_MS = 5000;

type TuiLike = { requestRender?: () => void };

function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

export class AgentWidget {
  readonly #ui: ExtensionUIContext;
  #tui: TuiLike | undefined;

  constructor(ui: ExtensionUIContext) {
    this.#ui = ui;
  }

  static render(snapshots: ReadonlyArray<AgentSnapshot>, now: number, width: number): string[] {
    const running = snapshots.filter((r) => r.status === "running").sort((a, b) => a.startedAt - b.startedAt);
    const recent = snapshots
      .filter((r) => r.status !== "running" && r.finishedAt !== undefined && now - r.finishedAt <= RECENT_MS)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const ordered = [...running, ...recent];
    const shown = ordered.slice(0, LIMIT);

    const lines = shown.map((r) => {
      // Include the id suffix so concurrent agents of the same type are distinguishable
      // (matches the child session name "<type>#<id8>").
      const label = `${r.name}#${r.id.slice(0, 8)}`;
      if (r.status === "running") {
        const tool = r.lastTool !== undefined ? ` · ${r.lastTool}` : "";
        return `● ${label}  ${formatElapsed(now - r.startedAt)}  ${r.description}${tool}`;
      }
      return `${SubagentResultMessage.statusGlyph(r.status)} ${label}  ${r.description}`;
    });
    const extra = ordered.length - shown.length;
    if (extra > 0) lines.push(`+${extra} more`);
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** Repaint on every registry change and on a 1s tick, for the life of the runtime. */
  get run(): Effect.Effect<void, never, AgentRegistry> {
    return Effect.gen({ self: this }, function* () {
      const registry = yield* AgentRegistry;
      const ticks = Stream.tick("1 second").pipe(Stream.mapEffect(() => registry.snapshots));
      yield* Stream.runForEach(Stream.merge(registry.changes, ticks), (snapshots) => this.#repaint(snapshots));
    });
  }

  #repaint(snapshots: ReadonlyArray<AgentSnapshot>): Effect.Effect<void> {
    return Effect.sync(() => {
      if (snapshots.length === 0) {
        this.#ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      this.#ui.setWidget(WIDGET_KEY, (tui: TuiLike) => {
        this.#tui = tui;
        return {
          render: (width: number) => AgentWidget.render(snapshots, Date.now(), width),
          invalidate: () => {},
        };
      });
      this.#tui?.requestRender?.();
    });
  }
}
