/**
 * mention-clone-system-prompt.e2e.test.ts — the clone reasons under the live
 * system prompt, against a real pi session.
 *
 * `mention-clone.test.ts` mocks `createAgentSession`, so it proves the clone
 * rewrites the leading system message of whatever session it is handed, not that
 * a real session obeys. Pi 1.x made `agent.state.systemPrompt` a read-only replay
 * of the transcript, which is what broke the plain assignment this file guards
 * against: the evidence here is the system prompt the faux model actually
 * receives on the clone's turn.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMentionClone } from "../../src/agent/mention/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const LIVE_PROMPT = "LIVE_PROMPT_FROM_THE_MAIN_SESSION";

describe("mention clone against a real pi session", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "mention-clone-e2e-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("sends the main session's live system prompt, not the one the clone rebuilt", async () => {
    const seen: string[] = [];
    faux.setResponses([
      (context: Context) => {
        seen.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage(fauxText("nothing to start"));
      },
    ]);

    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx = {
      cwd,
      model,
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      getSystemPrompt: () => LIVE_PROMPT,
      sessionManager: { getEntries: () => [], getLeafId: () => null },
    } as unknown as ExtensionContext;
    const agentTool = {
      name: "Agent",
      label: "Agent",
      description: "Start an agent.",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: vi.fn(),
    } as unknown as ToolDefinition;

    const result = await runMentionClone({ ctx, type: "Explore", message: "look around", agentTool });

    // The faux model never calls Agent, so the clone reports it did not start
    // the mention — the designed fallback result. A throw on the prompt would
    // surface as a different error, with no model call behind it.
    expect(result).toEqual({ spawned: false, error: "the conversation clone did not start it" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(LIVE_PROMPT);
  });
});
