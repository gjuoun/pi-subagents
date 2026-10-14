import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { type MentionRoster, mentionItems } from "../domain/mention.js";

/**
 * mention-completion.ts — `@` suggestions for agents, stacked on pi's own provider.
 *
 * pi's provider still answers for files on every `@`; agent rows go first. A failing inner
 * provider degrades to agent rows only. Ported from the v1 core's ui/agent-mention.ts.
 */
export function createMentionProvider(
  current: AutocompleteProvider,
  roster: () => Promise<MentionRoster>,
): AutocompleteProvider {
  return {
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const mine = mentionItems(await roster(), lines[cursorLine] ?? "", cursorCol);
      let theirs: AutocompleteSuggestions | null = null;
      try {
        theirs = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      } catch {
        theirs = null;
      }
      if (!mine) return theirs;
      const items = mine.items.map((i) => ({ ...i }));
      if (!theirs) return { items, prefix: mine.prefix };
      return { items: [...items, ...theirs.items], prefix: mine.prefix };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
