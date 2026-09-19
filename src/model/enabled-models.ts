/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) for scope validation.
 *
 * **Project overrides global**, mirroring pi's own `SettingsManager`
 * deep-merge behavior and matching the precedence we use for our own
 * `subagents.json` settings (see `src/settings.ts:loadSettings`). If
 * project file has `enabledModels` set, it wholly replaces global's
 * (array fields are replaced, not concatenated).
 *
 * **Limited subset of upstream's resolveModelScope.** We support exact
 * `provider/modelId` matching only. Upstream (pi-coding-agent's
 * `core/model-resolver.ts`) additionally supports glob patterns
 * (`*sonnet*`, `anthropic/*`), bare model IDs without provider, and
 * thinking-level suffixes (`provider/*:high`). Those forms are silently
 * ignored here — see `ModelScope` in model-scope.ts for where patterns turn
 * into an allowlist.
 *
 * In practice, pi's `/scoped-models` picker writes exact `provider/modelId`
 * entries, so the limitation is invisible for users who configure scope
 * through pi's UI. Hand-edited settings using globs or bare IDs will
 * produce an empty allowed set (scope check becomes a no-op).
 *
 * Example:
 *   enabledModels = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]
 *   → resolves to { "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6" }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { err, fromThrowable, ok, type Result } from "neverthrow";

/** Minimal registry shape — only the methods the scope check actually calls. */
export interface ModelRegistryRef {
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

/**
 * A settings file that exists but could not be read.
 *
 * Plain data rather than a catalog, because this failure has one producer, one
 * reader, and no recovery decision attached: the scope check says which file
 * broke and proceeds. `cause` is kept for that message; nothing branches on it.
 */
export interface SettingsReadFailure {
  path: string;
  cause: unknown;
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ];
}

/**
 * `mtimeMs-size` of one settings file, or `"missing"` when it is not there —
 * the stamp the scope cache invalidates on. A file that cannot be statted is
 * neither readable nor changed as far as the cache is concerned, so it reads as
 * absent; `fromThrowable` is the fence, and the fallback is the whole policy.
 */
const statStamp = fromThrowable(
  (path: string): string => {
    const s = statSync(path);
    return `${s.mtimeMs}-${s.size}`;
  },
  () => "missing",
);

/**
 * Fingerprint of both settings files, for a cache key that must also include the
 * directory they were read from — two projects whose files happen to share a
 * size and an mtime are otherwise indistinguishable.
 */
export function settingsFingerprint(cwd: string): string {
  const [project, global] = settingsPaths(cwd);
  return `${statStamp(project).unwrapOr("missing")};${statStamp(global).unwrapOr("missing")}`;
}

/**
 * Read `enabledModels` from a single settings.json file.
 *
 * Fenced adapter: `JSON.parse` on a user-editable file is the one throw this
 * module absorbs. `Ok(undefined)` covers every "nothing to use here" — no file,
 * no field, a field that is not an array — while `Err` says the file is there
 * and could not be parsed. The distinction is the point: a corrupt settings.json
 * used to be indistinguishable from an unconfigured one, so scope enforcement
 * switched itself off in silence.
 */
function readField(path: string): Result<string[] | undefined, SettingsReadFailure> {
  if (!existsSync(path)) return ok(undefined);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (cause) {
    return err({ path, cause });
  }
  const field = typeof raw === "object" && raw !== null
    ? (raw as { enabledModels?: unknown }).enabledModels
    : undefined;
  return ok(Array.isArray(field) ? (field as string[]) : undefined);
}

/**
 * Read enabledModels from pi's settings — project-local overrides global.
 *
 * `Ok(undefined)` means "no allowlist": neither file has the field, so the
 * scope check is a no-op. `Err` means a file the read reached — the project
 * one, or global when the project has no field of its own — exists but cannot
 * be parsed, and the caller decides what to say about it (see ModelScope.check).
 */
export function readEnabledModels(cwd: string): Result<string[] | undefined, SettingsReadFailure> {
  const [project, global] = settingsPaths(cwd);
  const projectField = readField(project);
  if (projectField.isErr()) return projectField;
  if (projectField.value !== undefined) return projectField;
  return readField(global);
}
