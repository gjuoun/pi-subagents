import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { ParentContext } from "./parent-context.service.js";

/**
 * settings.ts — the one setting the extension reads: `maxConcurrent` (JW-166).
 *
 * `~/.pi/eyu/subagents.json` then `<cwd>/.pi/subagents.json`, the project file winning;
 * default 10. Every other key in those files belongs to the retired v1 core and is ignored.
 * Read on every admission (no cache), so an edit applies to the next background spawn.
 */

export const DEFAULT_MAX_CONCURRENT = 10;

/**
 * The global config file: `~/.pi/eyu/subagents.json`. Deliberately not under the pi agent
 * dir — it is this extension's own file, keyed off `$HOME` so a relocated HOME still moves it.
 */
const globalConfigPath = (): string => join(homedir(), ".pi", "eyu", "subagents.json");

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

export class Settings extends Context.Service<Settings, SettingsShape>()("pi-subagents/v2/Settings") {
  static readonly live: Layer.Layer<Settings> = Layer.succeed(Settings, {
    maxConcurrent: Effect.gen(function* () {
      const parent = yield* ParentContext;
      const project = readMax(yield* readJson(join(parent.cwd, ".pi", "subagents.json")));
      const global = readMax(yield* readJson(globalConfigPath()));
      return project ?? global ?? DEFAULT_MAX_CONCURRENT;
    }),
  });

  /** A fixed limit, for tests. */
  static fixed(maxConcurrent: number): Layer.Layer<Settings> {
    return Layer.succeed(Settings, { maxConcurrent: Effect.succeed(maxConcurrent) });
  }
}
