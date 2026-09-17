/**
 * detail.ts — one agent: its menu, and the three file mutations behind it.
 *
 * Every write goes through `agent-file-toggle.ts` (so the frontmatter edits stay reachable from
 * tests) and then re-registers the merged set — the file on disk, not this menu, is what the next
 * spawn reads.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { disableInContent, enableInContent, isEmptyStub, locateAgentFile, personalAgentsDir, projectAgentsDir, serializeAgentFile } from "../../config/registry/agent-file-toggle.js";
import { getAgentConfig } from "../../config/registry/agent-types.js";
import type { AgentConfig } from "../../lib/types.js";
import type { AgentsUiDeps } from "./deps.js";

export async function showAgentDetail(ctx: ExtensionCommandContext, name: string, deps: AgentsUiDeps): Promise<void> {
  const cfg = getAgentConfig(name);
  if (!cfg) {
    ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
    return;
  }

  const file = locateAgentFile(name, cfg.sourcePath);
  const isDefault = cfg.isDefault === true;
  const disabled = cfg.enabled === false;

  let menuOptions: string[];
  if (disabled && file) {
    // Disabled agent with a file — offer Enable
    menuOptions = isDefault
      ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
      : ["Enable", "Edit", "Delete", "Back"];
  } else if (isDefault && !file) {
    // Default agent with no .md override
    menuOptions = ["Eject (export as .md)", "Disable", "Back"];
  } else if (isDefault && file) {
    // Default agent with .md override (ejected)
    menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
  } else {
    // User-defined agent
    menuOptions = ["Edit", "Disable", "Delete", "Back"];
  }

  const choice = await ctx.ui.select(name, menuOptions);
  if (!choice || choice === "Back") return;

  if (choice === "Edit" && file) {
    const content = readFileSync(file.path, "utf-8");
    const edited = await ctx.ui.editor(`Edit ${name}`, content);
    if (edited !== undefined && edited !== content) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, edited, "utf-8");
      deps.reloadCustomAgents();
      ctx.ui.notify(`Updated ${file.path}`, "info");
    }
  } else if (choice === "Delete") {
    if (file) {
      const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
      if (confirmed) {
        unlinkSync(file.path);
        deps.reloadCustomAgents();
        ctx.ui.notify(`Deleted ${file.path}`, "info");
      }
    }
  } else if (choice === "Reset to default" && file) {
    const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
    if (confirmed) {
      unlinkSync(file.path);
      deps.reloadCustomAgents();
      ctx.ui.notify(`Restored default ${name}`, "info");
    }
  } else if (choice.startsWith("Eject")) {
    await ejectAgent(ctx, name, cfg, deps);
  } else if (choice === "Disable") {
    await disableAgent(ctx, name, deps);
  } else if (choice === "Enable") {
    await enableAgent(ctx, name, deps);
  }
}
/** Eject a default agent: write its embedded config as a .md file. */
export async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig, deps: AgentsUiDeps): Promise<void> {
  const location = await ctx.ui.select("Choose location", [
    "Project (.pi/agents/)",
    `Personal (${personalAgentsDir()})`,
  ]);
  if (!location) return;

  const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  const content = serializeAgentFile(cfg);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, content, "utf-8");
  deps.reloadCustomAgents();
  ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
}
/** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
export async function disableAgent(ctx: ExtensionCommandContext, name: string, deps: AgentsUiDeps): Promise<void> {
  const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
  if (file) {
    // Existing file — set enabled: false in frontmatter (idempotent)
    const content = readFileSync(file.path, "utf-8");
    const { content: updated, outcome } = disableInContent(content);
    if (outcome === "already-disabled") {
      ctx.ui.notify(`${name} is already disabled.`, "info");
      return;
    }
    if (outcome === "no-frontmatter") {
      // Nothing to edit — say so rather than rewriting the file unchanged and
      // reporting success for a change that never happened.
      ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
      return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file.path, updated, "utf-8");
    deps.reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
    return;
  }

  // No file (built-in default) — create a stub
  const location = await ctx.ui.select("Choose location", [
    "Project (.pi/agents/)",
    `Personal (${personalAgentsDir()})`,
  ]);
  if (!location) return;

  const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${name}.md`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
  deps.reloadCustomAgents();
  ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
}
/** Enable a disabled agent by removing enabled: false from its frontmatter. */
export async function enableAgent(ctx: ExtensionCommandContext, name: string, deps: AgentsUiDeps): Promise<void> {
  const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
  if (!file) return;

  const content = readFileSync(file.path, "utf-8");
  const { content: updated, changed } = enableInContent(content);
  if (!changed && !isEmptyStub(updated)) {
    // The file carries no `enabled: false` to remove, so it was never disabled
    // by us — reporting success here would hide a no-op.
    ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
    return;
  }
  const { writeFileSync } = await import("node:fs");

  // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
  if (isEmptyStub(updated)) {
    unlinkSync(file.path);
    deps.reloadCustomAgents();
    ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
  } else {
    writeFileSync(file.path, updated, "utf-8");
    deps.reloadCustomAgents();
    ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
  }
}
