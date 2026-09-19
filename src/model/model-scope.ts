/**
 * model-scope.ts — `scopeModels` policy, shared by every spawn path so none can
 * escape the allowlist the others enforce: the top-level Agent tool, the nested
 * delegation tools, a workflow's `agent()`, and the RPC spawner.
 *
 * The state is an instance rather than a module global because it has two
 * writers — the settings applier in `index.ts` and the `/agents → Settings`
 * toggle — and one reader per spawn path, and because the allowlist cache has to
 * be keyed by working directory. `index.ts` constructs the one instance next to
 * the other activation services and parks it on the activation context; leaves
 * receive it through their deps slice, never by importing a singleton.
 */

import {
  type ModelRegistryRef,
  readEnabledModels,
  type SettingsReadFailure,
  settingsFingerprint,
} from "./enabled-models.js";
import type { ModelEntry } from "./model-resolver.js";

export type ModelScopeVerdict =
  /** In scope, or nothing to validate against (feature off / no allowlist). */
  | { kind: "ok" }
  /** Caller-supplied out-of-scope choice — refuse the spawn with this message. */
  | { kind: "error"; message: string }
  /** Frontmatter-pinned, parent-inherited, or unenforceable — proceed, but tell the user. */
  | { kind: "warn"; message: string };

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

/**
 * Resolve one exact `provider/modelId` pattern against the available models.
 * Example: "google/gemma-4-31b-it". Patterns without a slash (bare ids), with
 * glob characters, or with a `:thinking` suffix resolve to nothing — see
 * enabled-models.ts for why that subset is deliberate.
 */
function exactEntry(pattern: string, available: ModelEntry[]): ModelEntry | undefined {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return undefined; // bare modelId not supported
  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  return available.find(
    m => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
}

/**
 * Why enforcement is off for this spawn, naming the file that broke.
 *
 * A warning rather than an error, deliberately: the user's list is unreadable,
 * not empty, and refusing every spawn would turn a typo in one JSON file into a
 * dead extension. Loud-and-proceed is the fix for the silent version.
 */
function corruptSettingsMessage(failure: SettingsReadFailure): string {
  const cause = failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
  return `Model scope: ${failure.path} could not be parsed (${cause}) — scope enforcement unavailable for this spawn.`;
}

/**
 * The `scopeModels` policy: whether subagent model choices are validated against
 * `enabledModels`, and the resolved allowlist that validation reads.
 *
 * When enabled, choices are checked against `enabledModels` from pi's settings —
 * both global `<agentDir>/settings.json` and project-local `<cwd>/.pi/settings.json`
 * (project overrides global). Off by default; opt-in via `/agents → Settings`.
 * See the SubagentsSettings.scopeModels docstring for the hard-error vs
 * warn-and-proceed policy and its rationale.
 */
export class ModelScope {
  private enabled = false;

  /** Memoized allowlist, and the key it was resolved for: see {@link allowedFor}. */
  private cachedAllowed: Set<string> | undefined;
  private cachedKey: string | undefined;

  isEnabled(): boolean { return this.enabled; }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /**
   * Check the effective resolved model against the user's enabledModels list.
   *
   * scopeModels guards against *runtime* LLM choices, not user-level config:
   *   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
   *     out-of-scope choice; surface it so it picks differently).
   *   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
   *     user authored/installed this agent or chose the parent's model; trust it).
   *
   * The verdict is a three-way union rather than a `Result` because the caller's
   * decision is three-way: proceed, refuse, or proceed-and-say. The `Result` it
   * consumes — the settings read — is unwrapped here with an explicit branch, so
   * a corrupt settings file lands in that same warn channel.
   */
  check(args: {
    model: { provider: string; id: string } | undefined;
    cwd: string;
    modelRegistry: ModelRegistryRef;
    /** True when the model came from the tool call rather than frontmatter. */
    callerSupplied: boolean;
    /** Display name used in the warning toast. */
    agentLabel: string;
    /** The raw `model:` input, when there was one. */
    modelInput?: string;
  }): ModelScopeVerdict {
    const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput } = args;
    if (!this.enabled || !model) return { kind: "ok" };

    const patterns = readEnabledModels(cwd);
    if (patterns.isErr()) return { kind: "warn", message: corruptSettingsMessage(patterns.error) };

    const allowed = this.allowedFor(patterns.value, modelRegistry, cwd);
    if (!allowed || allowed.has(modelKey(model))) return { kind: "ok" };

    if (callerSupplied) {
      // Worded about the input as the caller spelled it; sees docs/rpc.md for the
      // citation. Keep this text byte-identical — it is quoted there.
      const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
      return {
        kind: "error",
        message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
      };
    }
    const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
    return {
      kind: "warn",
      message: `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
    };
  }

  /**
   * The allowlist for `patterns` read in `cwd`, memoized on the patterns, the
   * directory, and both settings files' mtime+size.
   *
   * The patterns alone already keep two directories apart, since the list a
   * directory resolves is what differs; the directory is in the key so a future
   * change to per-project resolution cannot silently serve one project's list to
   * another. The file fingerprint covers an edit that leaves the patterns
   * identical.
   *
   * `undefined` means "no allowlist": the feature is on but nothing usable
   * resolved, so the check is a no-op. Globs and bare ids are unsupported by
   * design, and locking a user out of every model over a pattern they did not
   * know was unsupported would be the worse failure.
   */
  private allowedFor(
    patterns: string[] | undefined,
    registry: ModelRegistryRef,
    cwd: string,
  ): Set<string> | undefined {
    const key = [cwd, JSON.stringify(patterns), settingsFingerprint(cwd)].join("\u0000");
    if (key === this.cachedKey) return this.cachedAllowed;

    const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
    const allowed = new Set<string>();
    for (const pattern of patterns ?? []) {
      const trimmed = pattern.trim();
      if (!trimmed) continue; // skip empty/whitespace
      const entry = exactEntry(trimmed, available);
      if (entry) allowed.add(modelKey(entry));
    }

    const result = allowed.size > 0 ? allowed : undefined;
    this.cachedKey = key;
    this.cachedAllowed = result;
    return result;
  }
}
