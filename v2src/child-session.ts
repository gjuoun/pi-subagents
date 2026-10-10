import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";
import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { GENERAL_PURPOSE_SYSTEM_PROMPT } from "./agent-type-catalog.js";
import { RunFailed, SpawnFailed } from "./errors.js";

/**
 * child-session.ts — one child pi AgentSession, wrapped.
 *
 * The pi boundary: every SDK call is a plain promise wrapped in tryPromise, and the whole
 * construction runs inside an AsyncLocalStorage marker so pi loading extensions FOR THE CHILD
 * makes v2's factory return early instead of nesting a runtime. `prompt` reads one turn and
 * answers with the child's own text; it never touches the registry.
 */

const childSessionContext = new AsyncLocalStorage<boolean>();

export interface SpawnSpec {
  readonly id: string;
  readonly type: string;
  readonly systemPrompt?: string;
  /** Built-in tool allowlist; undefined means "all built-ins minus Agent". */
  readonly tools?: ReadonlyArray<string>;
  /** "provider/id" for the child model; falls back to the parent's model. */
  readonly model?: string;
  readonly thinking?: string;
}

/** What one child turn produced: its answer text and the tools it called. */
export interface RunOutcome {
  readonly answer: string;
  readonly toolUses: number;
  readonly lastTool?: string;
}

/** Fired once per `tool_execution_start` while a turn runs. */
export type ActivityListener = (toolName: string) => void;

export class ChildSession {
  readonly #session: AgentSession;
  readonly #id: string;
  readonly #type: string;

  constructor(session: AgentSession, id: string, type: string) {
    this.#session = session;
    this.#id = id;
    this.#type = type;
  }

  /** True while pi is loading extensions for a child — v2 must not nest a runtime. */
  static isChildContext(): boolean {
    return childSessionContext.getStore() === true;
  }

  /** Spawn a child session beside the parent (file-backed iff the parent is). */
  static open(ctx: ExtensionContext, spec: SpawnSpec): Effect.Effect<ChildSession, SpawnFailed> {
    return Effect.tryPromise({
      try: () => childSessionContext.run(true, () => openSession(ctx, spec)),
      catch: (error) => new SpawnFailed({ reason: error instanceof Error ? error.message : String(error) }),
    }).pipe(Effect.map((session) => new ChildSession(session, spec.id, spec.type)));
  }

  /** The underlying pi session (for the registry's abort/dispose finalizer). */
  get session(): AgentSession {
    return this.#session;
  }

  /** The child session name: "<type>#<id8>". */
  get name(): string {
    return `${this.#type}#${this.#id.slice(0, 8)}`;
  }

  /**
   * Run one prompt, ending in the child's own final answer or RunFailed. Text is bounded by
   * the message count before the prompt, so a resume that produced nothing never inherits a
   * prior turn's answer. A final turn that stopped with an error, or hit the output-token
   * limit with no text, is a failure.
   */
  prompt(input: string, onActivity?: ActivityListener): Effect.Effect<RunOutcome, RunFailed> {
    return Effect.gen({ self: this }, function* () {
      const session = this.#session;
      const id = this.#id;
      const startIndex = session.messages.length;
      let accumulated = "";
      let toolUses = 0;
      let lastTool: string | undefined;

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_start" && event.message.role === "assistant") accumulated = "";
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          accumulated += event.assistantMessageEvent.delta;
        }
        if (event.type === "tool_execution_start") {
          toolUses += 1;
          lastTool = event.toolName;
          onActivity?.(event.toolName);
        }
      });

      yield* Effect.tryPromise({
        try: () => session.prompt(input),
        catch: (error) => new RunFailed({ id, reason: error instanceof Error ? error.message : String(error) }),
      }).pipe(Effect.ensuring(Effect.sync(() => unsubscribe())));

      const answer = accumulated.trim() || lastAssistantText(session, startIndex);
      const failure = finalTurnError(session, startIndex);
      if (failure !== undefined) {
        return yield* Effect.fail(new RunFailed({ id, reason: failure }));
      }
      return { answer, toolUses, lastTool };
    });
  }

  abort(): void {
    void this.#session.abort();
  }

  dispose(): void {
    this.#session.dispose();
  }
}

/** Resolve a "provider/id" spec against the parent registry, else the parent model. */
function resolveChildModel(ctx: ExtensionContext, spec: string | undefined) {
  if (spec === undefined) return ctx.model;
  const slash = spec.indexOf("/");
  if (slash <= 0) return ctx.model;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  return ctx.modelRegistry?.find?.(provider, id) ?? ctx.model;
}

async function openSession(ctx: ExtensionContext, spec: SpawnSpec): Promise<AgentSession> {
  const cwd = ctx.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const parentSessionFile = ctx.sessionManager?.getSessionFile?.();

  // The child is file-backed (with the parent link in its header) exactly when the parent
  // is; an in-memory parent spawns an in-memory child.
  const sessionManager = parentSessionFile
    ? SessionManager.create(cwd, dirname(parentSessionFile), { parentSession: parentSessionFile })
    : SessionManager.inMemory(cwd);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => spec.systemPrompt ?? GENERAL_PURPOSE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  // 0.80.8+ createAgentSession wants modelRuntime, but ExtensionContext only exposes the
  // registry facade — read the runtime off it (mirrors v1's agent-runner facade read).
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: resolveChildModel(ctx, spec.model),
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: loader,
    ...(spec.tools !== undefined && { tools: [...spec.tools] }),
    ...(spec.thinking !== undefined && { thinkingLevel: spec.thinking as never }),
    excludeTools: ["Agent"],
  });

  session.setSessionName(`${spec.type}#${spec.id.slice(0, 8)}`);
  await session.bindExtensions({});
  return session;
}

function extractText(content: ReadonlyArray<{ type?: string; text?: string }>): string {
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

/** Last non-empty assistant text at or after startIndex. */
function lastAssistantText(session: AgentSession, startIndex: number): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const value = extractText(msg.content as ReadonlyArray<{ type?: string; text?: string }>).trim();
    if (value) return value;
  }
  return "";
}

/** The failure reason of this run's final turn, if it failed. */
function finalTurnError(session: AgentSession, startIndex: number): string | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content as ReadonlyArray<{ type?: string; text?: string }>).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}
