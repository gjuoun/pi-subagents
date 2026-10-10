/**
 * agent-type.ts — the pure agent-type value and its markdown parser.
 *
 * Built-in general-purpose always exists; *.md files add more. The parser is dependency-free:
 * it reads a leading `---` frontmatter block of simple scalar `key: value` pairs and returns
 * undefined for anything it cannot understand (the caller logs and skips it).
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

export const GENERAL_PURPOSE: AgentType = {
  name: GENERAL_PURPOSE_NAME,
  description: "General-purpose agent that can work on any task.",
  systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
};

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

/** One non-scalar value we deliberately refuse to guess at (skip the file instead). */
const UNSUPPORTED_VALUE = /^[[{|>*&!]/;

function parseScalar(value: string): string {
  if (UNSUPPORTED_VALUE.test(value)) throw new Error(`unsupported frontmatter value: ${value}`);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalarMap(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) throw new Error(`unsupported frontmatter line: ${line}`);
    const value = line.slice(sep + 1).trim();
    out[line.slice(0, sep).trim()] = value === "" ? undefined : parseScalar(value);
  }
  return out;
}

/** Split a leading `---` frontmatter block off the body, or leave the whole text as body. */
function splitFrontmatter(text: string): { readonly frontmatter: Record<string, unknown>; readonly body: string } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  return {
    frontmatter: parseScalarMap(normalized.slice(4, endIndex)),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

/** The name a file contributes when its frontmatter declares none. */
const nameFromPath = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
};

/** Parse one agent .md file; undefined means malformed (the caller warns and skips it). */
export function parseAgentTypeMarkdown(path: string, text: string): AgentType | undefined {
  let parsed: { readonly frontmatter: Record<string, unknown>; readonly body: string };
  try {
    parsed = splitFrontmatter(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (error) {
    console.warn(`[pi-subagents/v2] Skipping ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const fm = parsed.frontmatter;
  const declared = typeof fm.name === "string" ? fm.name.trim() : "";
  const name = declared || nameFromPath(path);
  return {
    name,
    description: typeof fm.description === "string" && fm.description.trim() ? fm.description.trim() : name,
    systemPrompt: parsed.body.trim() || GENERAL_PURPOSE_SYSTEM_PROMPT,
    tools: parseTools(fm.tools),
    model: typeof fm.model === "string" ? fm.model : undefined,
    thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
    source: path,
  };
}
