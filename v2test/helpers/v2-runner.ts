/**
 * v2-runner.ts — the faux-model e2e host for the v2src rewrite (JG-117).
 *
 * Adapted from test/helpers/print-mode-runner.ts: the extension path points at
 * v2src/index.ts, the parent session can be file-backed (persist) so the child's
 * parentSession header can be asserted, and the subagent hold condition reads the
 * v2 handle (Symbol.for("pi-subagents:v2")) — a no-op until Step 6 publishes it.
 *
 * Reuses test/helpers/faux-model-backend.ts and test/helpers/pi-ai.ts unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type Context,
  type FauxContentBlock,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxModelBackend } from "../../test/helpers/faux-model-backend.js";
import { registerFauxProvider } from "../../test/helpers/pi-ai.js";

/** v2 extension entrypoint (repo v2src/index.ts). */
const EXTENSION_PATH = fileURLToPath(new URL("../../v2src/index.ts", import.meta.url));

/** The handle v2 publishes for the e2e hold (Step 6); absent before then. */
const V2_HANDLE_KEY = Symbol.for("pi-subagents:v2");

export interface V2Handle {
  hasRunning(): boolean;
  waitForAll(): Promise<void>;
  list(): Array<Record<string, unknown>>;
}

export type FauxReply = string | FauxContentBlock | FauxContentBlock[] | AssistantMessage;
export type FauxResponder = (
  context: Context,
  state: { callCount: number },
) => FauxReply | Promise<FauxReply>;

export interface V2RunOptions {
  prompt: string;
  /** Context-branching faux responder, invoked once per model call. */
  respond: FauxResponder;
  systemPrompt?: string;
  /** File-back the parent session into a temp sessionDir. */
  persist?: boolean;
  /** Explicit session dir (implies persist); default is a temp dir owned by the run. */
  sessionDir?: string;
  maxModelCalls?: number;
  hold?: boolean;
  timeoutMs?: number;
  cwd?: string;
  beforeRun?: () => void | Promise<void>;
  /** Called with the live parent session right after bind, before the turn. */
  onReady?: (session: AgentSession) => void;
}

export interface V2Run {
  responseText: string;
  parentSession: AgentSession;
  modelCalls: number;
  /** The file-backed session dir when persist was on, else undefined. */
  sessionDir: string | undefined;
  /** The parent's own session file (undefined for an in-memory parent). */
  parentSessionFile: string | undefined;
  handle: V2Handle | undefined;
  dispose: () => Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a headless orchestrator. Use the Agent tool to delegate, then report the result.";

/** Build an Agent tool call for a faux assistant turn. */
export function agentCall(
  args: {
    prompt: string;
    description: string;
    subagent_type?: string;
    run_in_background?: boolean;
    [k: string]: unknown;
  },
  opts?: { id?: string },
): ToolCall {
  return fauxToolCall("Agent", { subagent_type: "general-purpose", ...args }, opts);
}

/**
 * The common single-spawn flow: the parent emits until an Agent tool result is in
 * history, then parentFinal; the child (no Agent tool) always emits subagent.
 */
type Route = FauxReply | ((ctx: Context) => FauxReply | Promise<FauxReply>);

export function routeBySession(routes: {
  parentInitial: Route;
  parentFinal?: Route;
  subagent: Route;
}): FauxResponder {
  const resolve = (reply: Route, ctx: Context): FauxReply | Promise<FauxReply> =>
    typeof reply === "function" ? reply(ctx) : reply;
  return (context) => {
    const isParent = (context.tools ?? []).some((t) => t.name === "Agent");
    if (!isParent) return resolve(routes.subagent, context);
    const spawned = context.messages.some(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
    );
    if (spawned) {
      return routes.parentFinal != null ? resolve(routes.parentFinal, context) : "Done.";
    }
    return resolve(routes.parentInitial, context);
  };
}

function toAssistantMessage(reply: FauxReply): AssistantMessage {
  if (reply && typeof reply === "object" && "role" in reply) {
    return reply as AssistantMessage;
  }
  const content: FauxContentBlock[] =
    typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
  const hasToolCall = content.some((b) => (b as { type?: string }).type === "toolCall");
  return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
}

export async function runV2(options: V2RunOptions): Promise<V2Run> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ownsCwd = options.cwd == null;
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "v2-run-"));

  const prevCwd = process.cwd();
  process.chdir(cwd);

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  const hermeticDir = mkdtempSync(join(tmpdir(), "v2-run-home-"));
  process.env.PI_CODING_AGENT_DIR = hermeticDir;
  process.env.HOME = hermeticDir;

  const persist = options.persist ?? options.sessionDir != null;
  let ownsSessionDir = false;
  let sessionDir = options.sessionDir;
  if (persist && sessionDir == null) {
    sessionDir = mkdtempSync(join(tmpdir(), "v2-session-"));
    ownsSessionDir = true;
  }

  const faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: 200_000 }],
  });
  const model = faux.getModel();
  const { modelRuntime } = fauxModelBackend(model);
  const max = options.maxModelCalls ?? 16;
  const factory: FauxResponseStep = async (context, _opts, state) =>
    toAssistantMessage(await options.respond(context, state));
  faux.setResponses(Array.from({ length: max }, () => factory));

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [EXTENSION_PATH],
    systemPromptOverride: () => options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  await options.beforeRun?.();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: persist ? SessionManager.create(cwd, sessionDir) : SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  session.setSessionName("v2-host");
  await session.bindExtensions({});
  options.onReady?.(session);

  const handle = (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY] as V2Handle | undefined;

  // Subagent hold condition. No-op until Step 6 publishes the v2 handle.
  const hold = options.hold ?? true;
  if (hold && handle) {
    const agent = (session as unknown as { agent?: { dequeueFollowUpMessages?: (...a: unknown[]) => unknown } })
      .agent;
    if (agent?.dequeueFollowUpMessages) {
      const original = agent.dequeueFollowUpMessages.bind(agent);
      agent.dequeueFollowUpMessages = (...args: unknown[]) => {
        const messages = original(...args);
        if (Array.isArray(messages) && messages.length > 0) return messages;
        if (handle.hasRunning()) return handle.waitForAll().then(() => original(...args));
        return messages;
      };
    }
  }

  let responseText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") responseText = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  const parentSessionFile = session.sessionFile;

  const dispose = async () => {
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      /* ignore */
    }
    try {
      session.dispose?.();
    } catch {
      /* ignore */
    }
    faux.unregister();
    delete (globalThis as Record<symbol, unknown>)[V2_HANDLE_KEY];
    try {
      process.chdir(prevCwd);
    } catch {
      /* ignore */
    }
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(hermeticDir, { recursive: true, force: true });
    if (ownsSessionDir && sessionDir) rmSync(sessionDir, { recursive: true, force: true });
    if (ownsCwd) rmSync(cwd, { recursive: true, force: true });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`v2-runner timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await session.prompt(options.prompt);
        // Fallback for when the dequeue patch could not block the loop: drain any
        // still-running background children and re-prompt so their results land.
        if (hold && handle) {
          while (handle.hasRunning()) {
            await handle.waitForAll();
            await session.prompt("Background agents have completed. Process their results.");
          }
        }
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  if (!responseText.trim()) responseText = lastAssistantText(session);

  return {
    responseText: responseText.trim(),
    parentSession: session,
    modelCalls: faux.state.callCount ?? 0,
    sessionDir,
    parentSessionFile,
    handle,
    dispose,
  };
}

/** Text of every tool result by name (the e2e observable for a spawn). */
export function toolResultsNamed(session: AgentSession, toolName: string): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "toolResult") continue;
    if ((msg as { toolName?: string }).toolName !== toolName) continue;
    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("");
    out.push(text);
  }
  return out;
}

export function agentToolResults(session: AgentSession): string[] {
  return toolResultsNamed(session, "Agent");
}

/** All text across the whole conversation. */
export function conversationText(session: AgentSession): string {
  const parts: string[] = [];
  for (const msg of session.messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Names of every tool the assistant actually invoked (in order). */
export function invokedToolNames(session: AgentSession): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string }>) {
      if (block.type === "toolCall" && block.name) out.push(block.name);
    }
  }
  return out;
}

export function toolCallsNamed(session: AgentSession, toolName: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
      if (block.type === "toolCall" && block.name === toolName) {
        out.push((block.arguments ?? {}) as Record<string, unknown>);
      }
    }
  }
  return out;
}

export function agentToolCalls(session: AgentSession): Array<Record<string, unknown>> {
  return toolCallsNamed(session, "Agent");
}

function lastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}
