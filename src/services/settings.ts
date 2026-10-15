import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { ParentContext } from "./parent-context.service.js";

/**
 * settings.ts — the one setting the extension reads: `maxConcurrent` (JW-166).
 *
 * `~/.pi/eyu/config.json` under the `subagents` key, then `<cwd>/.pi/subagents.json`, the project
 * file winning; default 10. Every other key in those files belongs to the retired v1 core and is
 * ignored. A legacy `~/.pi/eyu/subagents.json` (pre-config.json) is absorbed once: its
 * `maxConcurrent` is merged into `config.json` — sibling keys preserved — and the legacy file is
 * renamed to `subagents.json.bak-<timestamp>`. Read on every admission (no cache), so an edit
 * applies to the next background spawn. Read/parse failure is `undefined`, never a throw.
 */

export const DEFAULT_MAX_CONCURRENT = 10;

/** The shared eyu config file; this extension owns its `subagents` top-level key. */
const globalConfigPath = (): string => join(homedir(), ".pi", "eyu", "config.json");

/** The pre-config.json global file, absorbed once and renamed away. */
const legacyConfigPath = (): string => join(homedir(), ".pi", "eyu", "subagents.json");

export interface SettingsShape {
  /** How many background agents may run at once. */
  readonly maxConcurrent: Effect.Effect<number, never, ParentContext>;
}

/** A positive integer from a parsed settings file, or undefined. */
function readMax(json: unknown): number | undefined {
  const value = (json as { maxConcurrent?: unknown } | null)?.maxConcurrent;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

const readJson = (path: string): Effect.Effect<unknown> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
    Effect.orElseSucceed(() => undefined),
  );

/** The whole file as an object, or undefined when absent, unreadable or not a JSON object. */
const readObject = (path: string): Effect.Effect<Record<string, unknown> | undefined> =>
  readJson(path).pipe(
    Effect.map((json) =>
      json !== null && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : undefined,
    ),
  );

/**
 * Merge the legacy `maxConcurrent` into `config.json` (atomic rename, siblings preserved) and
 * rename the legacy file aside. Best-effort: any failure returns false and leaves the file alone.
 */
const absorbLegacy = (legacyMax: number): Effect.Effect<boolean> =>
  Effect.tryPromise(async () => {
    const path = globalConfigPath();
    const current = await readFile(path, "utf8").catch(() => "{}");
    const parsed = JSON.parse(current) as unknown;
    const base =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(
      tmp,
      JSON.stringify({ ...base, subagents: { maxConcurrent: legacyMax } }, null, "\t") + "\n",
    );
    await rename(tmp, path);
    await rename(legacyConfigPath(), legacyConfigPath() + ".bak-" + Date.now());
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/** The global value: `config.json`'s `subagents.maxConcurrent`, absorbing a legacy file once. */
const readGlobalMax = (): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const config = yield* readObject(globalConfigPath());
    if (config !== undefined && "subagents" in config) {
      return readMax(config.subagents);
    }
    const legacyMax = readMax(yield* readObject(legacyConfigPath()));
    if (legacyMax !== undefined) {
      yield* absorbLegacy(legacyMax);
    }
    return legacyMax;
  });

export class Settings extends Context.Service<Settings, SettingsShape>()("pi-subagents/v2/Settings") {
  static readonly live: Layer.Layer<Settings> = Layer.succeed(Settings, {
    maxConcurrent: Effect.gen(function* () {
      const parent = yield* ParentContext;
      const project = readMax(yield* readJson(join(parent.cwd, ".pi", "subagents.json")));
      const global = yield* readGlobalMax();
      return project ?? global ?? DEFAULT_MAX_CONCURRENT;
    }),
  });

  /** A fixed limit, for tests. */
  static fixed(maxConcurrent: number): Layer.Layer<Settings> {
    return Layer.succeed(Settings, { maxConcurrent: Effect.succeed(maxConcurrent) });
  }
}
