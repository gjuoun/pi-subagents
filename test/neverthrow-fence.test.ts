/**
 * neverthrow-fence.test.ts — the architectural invariant behind the neverthrow
 * pilot: `try`/`catch` is absorbed only inside an enumerated set of adapters,
 * and nowhere else in the pilot's modules.
 *
 * "Eliminate try/catch" does not mean zero `catch` in a codebase; it means every
 * `catch` sits in a fixed, enumerable, test-locked list. This file is that lock
 * for `src/lib/result.ts`'s first consumers. A new `catch` in one of these files
 * fails here rather than being noticed in review — the fix is a `safe*` adapter
 * (or `fromThrowable`), not a new entry in {@link ALLOWED_CATCH_SITES}.
 *
 * The list is deliberately name-based rather than line-based: the pilot moves
 * plenty of lines, and a lock that churns on every edit is a lock nobody keeps.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The modules this fence covers — the pilot's blast radius, stated once. */
const PILOT_FILES = [
  "src/lib/json-schema.ts",
  "src/lib/usage.ts",
  "src/model/enabled-models.ts",
  "src/model/model-resolver.ts",
  "src/model/model-scope.ts",
];

/**
 * Every tolerated `catch`, as the enclosing declaration's name — one entry per
 * site, so two catches in one adapter look different from one catch in two.
 */
const ALLOWED_CATCH_SITES: Record<string, string[]> = {
  // The Check() smoke test, plus checkAgainst's two best-effort absorbers —
  // typebox throws on schemas it cannot walk, and that must not fail a run.
  // (A third absorber, JSON.stringify on a circular schema, is a fromThrowable
  // adapter and so writes no catch at all.)
  "src/lib/json-schema.ts": ["checkAgainst", "checkAgainst", "safeSmokeCheck"],
  // Session stats are read off a live pi session; a throw reads as "unknown".
  "src/lib/usage.ts": ["getSessionContextPercent"],
  // The settings reader's JSON.parse; the stat behind the cache key goes
  // through fromThrowable and so writes no catch.
  "src/model/enabled-models.ts": ["readField"],
  "src/model/model-resolver.ts": [],
  "src/model/model-scope.ts": [],
};

/**
 * The `catch` sites in `file`, named by the declaration they sit in.
 *
 * Only a real `catch` clause matches (`catch {` / `catch (`), so prose that
 * mentions one — every file here has some — is not counted.
 */
function catchSitesIn(file: string): string[] {
  const source = readFileSync(join(process.cwd(), file), "utf-8");
  const sites: string[] = [];
  let enclosing = "(top level)";
  for (const line of source.split("\n")) {
    const declaration = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/.exec(line);
    if (declaration) enclosing = declaration[1] ?? declaration[2] ?? enclosing;
    if (/\bcatch\s*[({]/.test(line)) sites.push(enclosing);
  }
  return sites.sort();
}

describe("neverthrow fence — throw absorbers in the pilot's modules", () => {
  it("absorbs throws only inside the enumerated adapters", () => {
    const found = Object.fromEntries(
      PILOT_FILES.map(file => [file, catchSitesIn(file)]),
    );
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED_CATCH_SITES).map(([file, names]) => [file, [...names].sort()]),
    );
    expect(found).toEqual(allowed);
  });
});
