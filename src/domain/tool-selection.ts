/**
 * tool-selection.ts — which tools a child session gets (JW-166 tools rule).
 *
 * Pure: the pi layer describes every registered tool as a ToolRef (its name, and the extension
 * that registered it — undefined for a built-in) and applies the returned names.
 *
 * - selectors undefined → every registered tool (`powershell` only on Windows);
 * - selectors set → exactly: plain names, `ext:<ext>` (all of that extension's tools) and
 *   `ext:<ext>/<tool>` (one of them);
 * - the subagent tools never reach a child, whatever the selectors say.
 */

export const SUBAGENT_TOOL_NAMES: ReadonlyArray<string> = ["Agent", "get_subagent_result", "steer_subagent"];

export interface ToolRef {
  readonly name: string;
  /** The registering extension's name; undefined for a built-in. */
  readonly extension?: string;
}

export function selectChildTools(
  registered: ReadonlyArray<ToolRef>,
  selectors: ReadonlyArray<string> | undefined,
  options: { readonly platform: string; readonly keep?: ReadonlyArray<string> },
): string[] {
  const denied = new Set(SUBAGENT_TOOL_NAMES.filter((n) => !(options.keep ?? []).includes(n)));
  const picked =
    selectors === undefined
      ? registered.filter((t) => t.name !== "powershell" || options.platform === "win32")
      : registered.filter((t) => selectors.some((s) => matches(t, s.trim())));
  return picked.map((t) => t.name).filter((name) => !denied.has(name));
}

function matches(tool: ToolRef, selector: string): boolean {
  if (!selector.startsWith("ext:")) return tool.name === selector;
  const rest = selector.slice(4);
  const slash = rest.indexOf("/");
  const ext = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (tool.extension?.toLowerCase() !== ext) return false;
  return slash === -1 || tool.name === rest.slice(slash + 1);
}
