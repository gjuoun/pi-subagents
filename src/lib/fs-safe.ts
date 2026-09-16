/**
 * fs-safe.ts — the small filesystem guardrails the name-and-file loaders share.
 *
 * Hoisted out of `agent/prompt/memory.ts`: `agent/prompt/skill-loader.ts` and
 * `workflow/script/saved.ts` both need them, so `workflow/` was reaching into `agent/prompt/`
 * for them — a reach-around with no other reason to exist. They are pure and touch nothing
 * internal, which is what admits them to `lib/`.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  if (isSymlink(filePath)) return undefined;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}
