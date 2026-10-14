/**
 * agent-type.ts — the pure agent-type value and its markdown parser.
 *
 * There are no built-in agents: every type comes from an *.md file (JW-166). The parser is
 * dependency-free: it reads a leading `---` frontmatter block of simple scalar `key: value`
 * pairs and returns undefined for anything it cannot understand (the caller logs and skips it).
 */



export interface AgentType {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  /**
   * Tool allowlist as written: built-in names plus `ext:<extension>` and
   * `ext:<extension>/<tool>` selectors. undefined means every tool.
   */
  readonly tools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly thinking?: string;
  /** Turn cap; undefined means unlimited. */
  readonly maxTurns?: number;
  /** Whether pi's skills index reaches the child. */
  readonly skills: boolean;
  /** Badge color as written (hex or a Claude Code name); validated by the ui layer. */
  readonly color?: string;
  /** A disabled type is invisible to resolve and names. */
  readonly enabled: boolean;
  readonly source?: string;
}

/** `false`/`no`/`off` (any case) is false; anything else, or absent, is the fallback. */
function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "no" || v === "off") return false;
  if (v === "true" || v === "yes" || v === "on") return true;
  return fallback;
}

/** A positive integer turn cap; 0, negative or unparsable means unlimited. */
function parseMaxTurns(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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

/** A non-scalar value we deliberately refuse to guess at (skip the file instead). */
const UNSUPPORTED_VALUE = /^[[{|>*&!]/;

/** undefined means the value is not a simple scalar. */
function parseScalar(value: string): string | undefined {
  if (UNSUPPORTED_VALUE.test(value)) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** undefined means a line we cannot understand, so the whole file is skipped. */
function parseScalarMap(yaml: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) return undefined;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (value === "") {
      out[key] = undefined;
      continue;
    }
    const scalar = parseScalar(value);
    if (scalar === undefined) return undefined;
    out[key] = scalar;
  }
  return out;
}

/** Split a leading `---` frontmatter block off the body, or leave the whole text as body. */
function splitFrontmatter(text: string): { readonly frontmatter: Record<string, unknown>; readonly body: string } | undefined {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const frontmatter = parseScalarMap(normalized.slice(4, endIndex));
  if (frontmatter === undefined) return undefined;
  return { frontmatter, body: normalized.slice(endIndex + 4).trim() };
}

/** The name a file contributes when its frontmatter declares none. */
const nameFromPath = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
};

/** Parse one agent .md file; undefined means malformed (the caller warns and skips it). */
export function parseAgentTypeMarkdown(path: string, text: string): AgentType | undefined {
  const parsed = splitFrontmatter(text.startsWith("\uFEFF") ? text.slice(1) : text);
  if (parsed === undefined) {
    console.warn(`[pi-subagents/v2] Skipping ${path}: malformed frontmatter`);
    return undefined;
  }
  const fm = parsed.frontmatter;
  const declared = typeof fm.name === "string" ? fm.name.trim() : "";
  const name = declared || nameFromPath(path);
  return {
    name,
    description: typeof fm.description === "string" && fm.description.trim() ? fm.description.trim() : name,
    systemPrompt: parsed.body.trim(),
    tools: parseTools(fm.tools),
    model: typeof fm.model === "string" ? fm.model : undefined,
    thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
    maxTurns: parseMaxTurns(fm.max_turns),
    skills: parseBool(fm.skills, true),
    color: typeof fm.color === "string" && fm.color.trim() ? fm.color.trim() : undefined,
    enabled: parseBool(fm.enabled, true),
    source: path,
  };
}
