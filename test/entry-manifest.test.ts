import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extensionCanonicalName, extensionCanonicalNames } from "../src/agent/session/extension-scope.js";

/**
 * Guards this repo's OWN entry manifest — the surface nothing else covers.
 *
 * Every other test of the canonical-name rule builds its own package under `mkdtemp`
 * (`agent-runner.test.ts`'s `extensionCanonicalNames (#143 …)` block writes a synthetic
 * `src/index.ts` and a synthetic manifest). Those tests pin the RULE and stay green no matter
 * what this repo's real `package.json` says, so before this file existed nothing asserted
 * that the shipped entry resolves, or that it still derives the name users are told to write.
 *
 * Why that name matters: `extensionCanonicalName` maps `index.ts` to its parent directory
 * name, so `./src/index.ts` canonicalises to **`src`** — a user-facing allowlist token that
 * appears in agent frontmatter as `extensions: [src]`, `exclude_extensions: [src]` and
 * `tools: ext:src`. `README.md` documents it ("a package whose entry is `src/index.ts` also
 * answers to `[src]`"), and `CHANGELOG.md`'s `#143` entry added the package-name alias
 * *because* the path-derived name existed. Moving that entry to `src/extension/index.ts`
 * would silently stop every one of those selectors matching — no error, the extension is
 * just no longer scoped the way the user wrote it. Nothing would go red.
 *
 * So this file asserts both halves against the real manifest rather than a fixture:
 * the declared entry exists on disk, and it still canonicalises to `src`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The real manifest, read the way pi reads it — not a fixture. */
const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  pi?: { extensions?: string[] };
};

const entries = manifest.pi?.extensions ?? [];
const entry = entries[0];
const entryAbs = resolve(REPO_ROOT, entry);

describe("entry manifest (package.json pi.extensions)", () => {
  it("declares at least one extension entry", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("points the declared entry at a file that exists", () => {
    expect(existsSync(entryAbs), `${entry} does not exist in this checkout`).toBe(true);
  });

  it("still canonicalises to the legacy allowlist token `src`", () => {
    // The assertion that catches a move. `index.ts` resolves to its parent directory name,
    // so this fails the moment the entry stops living directly in `src/`.
    expect(extensionCanonicalName(entryAbs)).toBe("src");
  });

  it("still answers to the package name as the documented alias", () => {
    const names = extensionCanonicalNames(entryAbs);
    expect(names).toContain("src");
    expect(names).toContain("pi-subagents");
  });
});
