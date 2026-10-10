import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Effect, Option } from "effect";
import { UnknownAgentType } from "./errors.js";

/**
 * agent-type-catalog.ts — resolve a subagent_type to its prompt/tools/model.
 *
 * Built-in general-purpose always exists; *.md files add more, read from the global agents
 * dir then the project .pi/agents dir (project wins on a name clash). A malformed or
 * unreadable file is logged and skipped — one bad file must not stop the rest.
 */

export const GENERAL_PURPOSE_NAME = "general-purpose";

export const GENERAL_PURPOSE_SYSTEM_PROMPT =
  "You are a general-purpose subagent. Complete the task autonomously and reply with a concise final answer.";

export interface AgentType {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  /** Built-in tool allowlist; undefined means "all built-ins". */
  readonly tools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly thinking?: string;
  readonly source?: string;
}

const GENERAL_PURPOSE: AgentType = {
  name: GENERAL_PURPOSE_NAME,
  description: "General-purpose agent that can work on any task.",
  systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
};

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
}

function parseTools(value: unknown): ReadonlyArray<string> | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw.toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export class AgentTypeCatalog {
  /** general-purpose is always present, without any file on disk. */
  static readonly GENERAL_PURPOSE: AgentType = GENERAL_PURPOSE;

  readonly #types: ReadonlyMap<string, AgentType>;

  private constructor(types: ReadonlyMap<string, AgentType>) {
    this.#types = types;
  }

  /** Read the global then the project agents dir; a project file wins a name clash. */
  static load(cwd: string): Effect.Effect<AgentTypeCatalog> {
    return Effect.gen(function* () {
      const byName = new Map<string, AgentType>();
      byName.set(GENERAL_PURPOSE.name, GENERAL_PURPOSE);
      for (const dir of [join(getAgentDir(), "agents"), join(cwd, ".pi", "agents")]) {
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
          const type = AgentTypeCatalog.fromMarkdown(path, text.value);
          if (type !== undefined) byName.set(type.name, type);
        }
      }
      return new AgentTypeCatalog(byName);
    });
  }

  resolve(name: string): Effect.Effect<AgentType, UnknownAgentType> {
    const found = this.#types.get(name);
    return found !== undefined
      ? Effect.succeed(found)
      : Effect.fail(new UnknownAgentType({ requested: name, available: this.names() }));
  }

  names(): ReadonlyArray<string> {
    return [...this.#types.keys()];
  }

  private static fromMarkdown(path: string, text: string): AgentType | undefined {
    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try {
      parsed = parseFrontmatter<Record<string, unknown>>(text.startsWith("\uFEFF") ? text.slice(1) : text);
    } catch (error) {
      console.warn(`[pi-subagents/v2] Skipping ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const fm = parsed.frontmatter;
    const declared = typeof fm.name === "string" ? fm.name.trim() : "";
    const name = declared || basename(path, ".md");
    return {
      name,
      description: typeof fm.description === "string" && fm.description.trim() ? fm.description.trim() : name,
      systemPrompt: parsed.body.trim() || GENERAL_PURPOSE_SYSTEM_PROMPT,
      tools: parseTools(fm.tools),
      model: typeof fm.model === "string" ? fm.model : undefined,
      thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
      source: path,
    } satisfies AgentType;
  }
}
