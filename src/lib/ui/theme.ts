/**
 * theme.ts — the shared UI contract every widget surface draws against.
 *
 * `Theme`/`UICtx` are pi's rendering surface, not this extension's. Four sibling files
 * (`fleet-list`, `workflow-card`, `workflow-dialog`, `conversation-viewer`) used to import
 * `ui/agent-widget.ts` — a 666-line component — purely to borrow the two-method type.
 *
 * Deliberately dependency-free: this is the leaf of the UI import graph, so anything that
 * renders can depend on it without dragging a component or an agent in behind it.
 */

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  /**
   * Paint a row with one of pi's background colors.
   *
   * Optional because a theme is not required to have one — pi's own `Theme` does, and a test
   * double that only implements `fg`/`bold` renders no tint rather than failing.
   */
  bg?(color: string, text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};
