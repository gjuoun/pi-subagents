import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Option } from "effect";
import { type AgentType, parseAgentTypeMarkdown } from "../domain/agent-type.js";
import { CatalogError } from "../domain/errors.js";
import { ParentContext, type ParentContextShape } from "./parent-context.service.js";

/**
 * agent-type-catalog.ts — resolve a subagent_type to its prompt/tools/model.
 *
 * The class service reads the global agents dir then the project .pi/agents dir from
 * ParentContext on every call (project wins a name clash; no caching — the disk is the source
 * of truth). A malformed or unreadable file is logged and skipped: one bad file must not stop
 * the rest. There are no built-in types, and a file with `enabled: false` is invisible — a
 * project file can disable a same-named global one.
 */

export interface AgentTypeCatalogShape {
  readonly resolve: (name: string) => Effect.Effect<AgentType, CatalogError, ParentContext>;
  readonly names: () => Effect.Effect<ReadonlyArray<string>, never, ParentContext>;
  /** Every enabled type (for /agents and @ completion). */
  readonly list: () => Effect.Effect<ReadonlyArray<AgentType>, never, ParentContext>;
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
}

/** Read the global then the project agents dir; a project file wins a name clash. */
const loadTypes = (parent: ParentContextShape): Effect.Effect<ReadonlyMap<string, AgentType>> =>
  Effect.gen(function* () {
    const byName = new Map<string, AgentType>();
    for (const dir of [join(parent.agentDir, "agents"), join(parent.cwd, ".pi", "agents")]) {
      const files = yield* Effect.promise(() => markdownFiles(dir));
      for (const file of files) {
        const path = join(dir, file);
        const text = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (error) => error,
        }).pipe(Effect.option);
        if (Option.isNone(text)) {
          console.warn(`[pi-subagents/v2] Skipping ${path}: unreadable`);
          continue;
        }
        const type = parseAgentTypeMarkdown(path, text.value);
        if (type !== undefined) byName.set(type.name, type);
      }
    }
    for (const [name, type] of byName) if (!type.enabled) byName.delete(name);
    return byName;
  });

const makeAgentTypeCatalog: Effect.Effect<AgentTypeCatalogShape> = Effect.succeed({
  resolve: (name) =>
    Effect.gen(function* () {
      const parent = yield* ParentContext;
      const byName = yield* loadTypes(parent);
      const found = byName.get(name);
      return found !== undefined
        ? found
        : yield* Effect.fail(CatalogError.UnknownAgentType({ requested: name, available: [...byName.keys()] }));
    }),
  names: () =>
    Effect.gen(function* () {
      const parent = yield* ParentContext;
      const byName = yield* loadTypes(parent);
      return [...byName.keys()];
    }),
  list: () =>
    Effect.gen(function* () {
      const parent = yield* ParentContext;
      return [...(yield* loadTypes(parent)).values()];
    }),
});

export class AgentTypeCatalog extends Context.Service<AgentTypeCatalog>()("pi-subagents/v2/AgentTypeCatalog", {
  make: makeAgentTypeCatalog,
}) {}
