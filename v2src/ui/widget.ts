import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Effect, Stream } from "effect";
import type { AgentSnapshot } from "../agent.js";
import { AgentRegistry } from "../agent-registry.js";
import type { AppRuntime } from "../runtime.js";
import { statusGlyph } from "./result-message.js";

/**
 * widget.ts — the pure widget renderer plus its thin pi wiring.
 *
 * One line per running agent, then agents that finished in the last few seconds; capped,
 * with a "+N more" tail. Lines are truncated to the pane width. The wiring forks a fiber
 * into the runtime that repaints on every registry change and on a 1s clock; it dies with
 * the runtime on session_shutdown.
 */

export const WIDGET_KEY = "pi-subagents-v2";
const LIMIT = 5;
const RECENT_MS = 5000;

function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

export function renderWidget(records: ReadonlyArray<AgentSnapshot>, now: number, width: number): string[] {
  const running = records
    .filter((r) => r.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  const recent = records
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
    return `${statusGlyph(r.status)} ${label}  ${r.description}`;
  });
  const extra = ordered.length - shown.length;
  if (extra > 0) lines.push(`+${extra} more`);
  return lines.map((line) => truncateToWidth(line, width));
}

type TuiLike = { requestRender?: () => void };

export function installWidget(runtime: AppRuntime, ui: ExtensionUIContext): void {
  let tui: TuiLike | undefined;

  const repaint = (records: ReadonlyArray<AgentSnapshot>) =>
    Effect.sync(() => {
      if (records.length === 0) {
        ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(WIDGET_KEY, (theTui: TuiLike) => {
        tui = theTui;
        return {
          render: (width: number) => renderWidget(records, Date.now(), width),
          invalidate: () => {},
        };
      });
      tui?.requestRender?.();
    });

  runtime.runFork(
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const changes = registry.changes;
      const ticks = Stream.tick("1 second").pipe(Stream.mapEffect(() => registry.snapshots));
      yield* Stream.runForEach(Stream.merge(changes, ticks), (records) => repaint(records));
    }),
  );
}
