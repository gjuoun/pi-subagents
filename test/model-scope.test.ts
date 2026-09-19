// model-scope.ts is the one place the scopeModels policy is decided. Its
// `error` verdict was reachable only indirectly, through one nested-tools case;
// the `warn` verdict — the whole reason the policy is a three-way split rather
// than a boolean — was never exercised at all.
//
// The split is the point: a model the ORCHESTRATOR picked at runtime is refused,
// because it can pick again; a model the USER pinned in frontmatter (or that was
// inherited from the parent) only warns, because refusing it would break every
// pinned agent the moment someone enables the setting. Collapsing the two in
// either direction is a one-line edit with no test in the way.
//
// The policy is an instance (`ModelScope`) rather than module state, so every
// test here builds its own: no snapshot-and-restore of a process-global, and no
// order dependency between suites.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRegistryRef } from "../src/model/enabled-models.js";
import { ModelScope } from "../src/model/model-scope.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistryRef {
  return {
    getAll() { return models; },
    getAvailable: available ? () => available : undefined,
  };
}

const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const OPUS = { provider: "anthropic", id: "claude-opus-4-6" };

describe("ModelScope.check", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  /** The policy under test — a fresh instance per test, so nothing leaks. */
  let scope: ModelScope;

  beforeEach(() => {
    // The allowlist is memoized per (cwd, patterns, mtime+size of both settings
    // files). A fresh project dir per test keeps one case's allowlist from being
    // served to the next.
    projectDir = mkdtempSync(join(tmpdir(), "pi-scope-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-scope-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    scope = new ModelScope();
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function settingsFile(dir: string) {
    return join(dir, ".pi", "settings.json");
  }

  function setEnabledModels(models: string[], dir = projectDir) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(settingsFile(dir), JSON.stringify({ enabledModels: models }));
  }

  function check(overrides: Partial<Parameters<ModelScope["check"]>[0]> = {}) {
    return scope.check({
      model: OPUS,
      cwd: projectDir,
      modelRegistry: makeRegistry(),
      callerSupplied: true,
      agentLabel: "scout",
      ...overrides,
    });
  }

  it("is off by default", () => {
    expect(scope.isEnabled()).toBe(false);
  });

  it("is a no-op while the feature is off, even for an out-of-scope model", () => {
    scope.setEnabled(false);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check().kind).toBe("ok");
  });

  it("is a no-op when no model was resolved", () => {
    scope.setEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check({ model: undefined }).kind).toBe("ok");
  });

  it("is a no-op when the user has no enabledModels configured", () => {
    scope.setEnabled(true);
    expect(check().kind).toBe("ok");
  });

  it("is a no-op when enabledModels resolves to nothing usable", () => {
    // Globs and bare ids are deliberately unsupported; an unresolvable list
    // must disable the check rather than lock the user out of every model.
    scope.setEnabled(true);
    setEnabledModels(["anthropic/*", "haiku"]);
    expect(check().kind).toBe("ok");
  });

  it("passes an in-scope model", () => {
    scope.setEnabled(true);
    setEnabledModels(["anthropic/claude-opus-4-6"]);
    expect(check().kind).toBe("ok");
  });

  it("drops whitespace-only patterns instead of letting them swallow the list", () => {
    scope.setEnabled(true);
    setEnabledModels(["  ", "anthropic/claude-haiku-4-5"]);
    expect(check({ model: HAIKU }).kind).toBe("ok");
    expect(check().kind).toBe("error");
  });

  it("counts only entries the registry can actually serve", () => {
    // A listed model with no auth is not usable, so it is not allowed — the
    // spawn would fail on a missing key instead.
    scope.setEnabled(true);
    setEnabledModels(["anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"]);
    expect(check({ modelRegistry: makeRegistry(MODELS, [MODELS[1]]) }).kind).toBe("error");
  });

  it("is a no-op when none of the listed models is available", () => {
    // Nothing with auth resolves, so there is no allowlist to enforce — the
    // same no-op as an unconfigured list, not an empty one that refuses all.
    scope.setEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check({ modelRegistry: makeRegistry(MODELS, []) }).kind).toBe("ok");
  });

  it("lists a duplicated pattern once in the refusal message", () => {
    scope.setEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5"]);
    const verdict = check();
    expect(verdict.kind).toBe("error");
    const message = (verdict as { message: string }).message;
    expect(message.match(/claude-haiku-4-5/g)).toHaveLength(1);
  });

  it("keeps one directory's allowlist out of another's", () => {
    // Neither directory may be served the other's allowlist, even when the two
    // settings files share a size and an mtime. The resolved patterns are part
    // of the cache key, so two directories cannot collide on their own lists;
    // the directory is in the key as well, so a future change to how a list is
    // resolved per project cannot silently leak one into the other.
    scope.setEnabled(true);
    const otherDir = mkdtempSync(join(tmpdir(), "pi-scope-other-"));
    try {
      setEnabledModels(["anthropic/claude-opus-4-6"]);
      setEnabledModels(["anthropic/claude-sonnet-4-6"], otherDir);
      const stamp = new Date(1_700_000_000_000);
      utimesSync(settingsFile(projectDir), stamp, stamp);
      utimesSync(settingsFile(otherDir), stamp, stamp);

      expect(check().kind).toBe("ok");
      expect(check({ cwd: otherDir }).kind).toBe("error");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("warns, and keeps going, when the settings file cannot be parsed", () => {
    // The defect this pins: a corrupt settings.json used to read exactly like an
    // unconfigured one, so turning scope on enforced nothing while looking on.
    // Fail open, but say so.
    scope.setEnabled(true);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(settingsFile(projectDir), "not json {{{");

    const verdict = check();
    expect(verdict.kind).toBe("warn");
    const message = (verdict as { message: string }).message;
    expect(message).toContain("could not be parsed");
    expect(message).toContain(settingsFile(projectDir));
    expect(message).toContain("scope enforcement unavailable");
  });

  describe("out of scope", () => {
    beforeEach(() => {
      scope.setEnabled(true);
      setEnabledModels(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"]);
    });

    it("refuses a caller-supplied choice and lists what is allowed", () => {
      const verdict = check({ callerSupplied: true, modelInput: "anthropic/claude-opus-4-6" });
      expect(verdict.kind).toBe("error");
      const message = (verdict as { message: string }).message;
      expect(message).toContain('"anthropic/claude-opus-4-6"');
      expect(message).toContain("  anthropic/claude-haiku-4-5");
      expect(message).toContain("  anthropic/claude-sonnet-4-6");
    });

    it("only warns for a frontmatter-pinned choice, so the spawn still proceeds", () => {
      const verdict = check({ callerSupplied: false, modelInput: "anthropic/claude-opus-4-6" });
      expect(verdict.kind).toBe("warn");
      expect((verdict as { message: string }).message)
        .toBe('Agent "scout" using out-of-scope model "anthropic/claude-opus-4-6"');
    });

    it("names the resolved model in the warning when there was no raw input", () => {
      // Parent-inherited: nothing was typed, so the label falls back to the
      // resolved provider/id rather than rendering "undefined".
      const verdict = check({ callerSupplied: false, modelInput: undefined });
      expect(verdict.kind).toBe("warn");
      expect((verdict as { message: string }).message).toContain("anthropic/claude-opus-4-6");
      expect((verdict as { message: string }).message).not.toContain("undefined");
    });

    it("stops enforcing as soon as the setting is turned back off", () => {
      expect(check().kind).toBe("error");
      scope.setEnabled(false);
      expect(check().kind).toBe("ok");
    });

    it("treats scope as case-insensitive on both sides", () => {
      setEnabledModels(["Anthropic/Claude-Opus-4-6"]);
      expect(check({ model: OPUS }).kind).toBe("ok");
      expect(check({ model: HAIKU }).kind).toBe("error");
    });
  });
});
