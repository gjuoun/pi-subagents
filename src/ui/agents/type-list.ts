/**
 * type-list.ts — `/agents → Agent types`, and the model label each row carries.
 *
 * One row per registered type, rendered through `SettingsList` so a long description sits under
 * the highlighted row instead of wrapping the list. The value column is the resolved model: what
 * the agent is configured with, and — when the runtime would fall back — what it actually resolves
 * to, because a configured-but-unresolvable model is worth seeing rather than hiding.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { getModelLabelFromConfig } from "../../agent/description.js";
import { getAgentConfig, getAllTypes } from "../../config/registry/agent-types.js";
import type { AgentConfig } from "../../lib/types.js";
import { type ModelRegistry, resolveModel } from "../../model/model-resolver.js";
import type { AgentsUiDeps } from "./deps.js";
import { showAgentDetail } from "./detail.js";

function getModelLabel(type: string, registry?: ModelRegistry): string {
  const cfg = getAgentConfig(type);
  if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
  const label = getModelLabelFromConfig(cfg.model);
  if (!registry) return label;
  const resolved = resolveModel(cfg.model, registry);
  // Configured but unresolvable: the runtime silently falls back to the parent
  // model, so flag it (and the fallback) rather than hiding the config.
  if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
  // Surface what it actually resolved to when that differs from the config —
  // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
  // differences are normalized away so an effectively-identical match stays quiet.
  const resolvedFull = `${resolved.provider}/${resolved.id}`;
  const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
  if (norm(cfg.model) === norm(resolvedFull)) return label;
  return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
}
export async function showAllAgentsList(ctx: ExtensionCommandContext, deps: AgentsUiDeps): Promise<void> {
  const allNames = getAllTypes();
  if (allNames.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
  // Disabled agents get ✕ prefix
  const sourceIndicator = (cfg: AgentConfig | undefined) => {
    const disabled = cfg?.enabled === false;
    if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
    if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
    if (disabled) return "✕  ";
    return "   ";
  };

  // One row per agent (name in the left column, model on the right); the
  // full description renders below the highlighted row via SettingsList,
  // exactly like the Settings menu — so long descriptions never wrap the list.
  const items: SettingItem[] = allNames.map(name => {
    const cfg = getAgentConfig(name);
    const disabled = cfg?.enabled === false;
    const model = getModelLabel(name, ctx.modelRegistry);
    return {
      id: name,
      label: `${sourceIndicator(cfg)}${name}`,
      currentValue: model,
      description: disabled ? "(disabled)" : (cfg?.description ?? name),
      // Single-value list so Enter "activates" the row (fires onChange with the
      // agent's id) without offering anything to actually cycle.
      values: [model],
    };
  });

  const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
  const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
  const legendParts: string[] = [];
  if (hasCustom) legendParts.push("• = project  ◦ = global");
  if (hasDisabled) legendParts.push("✕ = disabled");

  const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const slTheme = getSettingsListTheme();
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      slTheme,
      id => done(id), // Enter/Space on a row → return that agent's name
      () => done(undefined), // Esc → cancel
    );
    const container = new Container();
    container.addChild(new Text("Agent types", 0, 0));
    if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  });

  if (selected && getAgentConfig(selected)) {
    await showAgentDetail(ctx, selected, deps);
    await showAllAgentsList(ctx, deps);
  }
}
