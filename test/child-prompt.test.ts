import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticDir } from "./helpers/boot-extension.js";
import { agentCall, agentToolResults, routeBySession, runV2, systemPromptOf, type V2Run } from "./helpers/v2-runner.js";

/**
 * child-prompt.test.ts — the child's system prompt is laid out like a pil session (JW-166
 * Step 4): pi's own structured prompt, the persona in the addendum behind an
 * <active_agent/> tag, and the cwd's AGENTS.md in project_context.
 */

const SCOUT = "---\nname: scout\ndescription: A scout\ntools: read\n---\nSCOUT-PERSONA-41";

describe("v2 child prompt layout", () => {
  let run: V2Run | undefined;
  let hermetic: ReturnType<typeof hermeticDir> | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  it("builds pi's prompt with the persona in the addendum and AGENTS.md in project_context", async () => {
    hermetic = hermeticDir({ agentFiles: { scout: SCOUT } });
    writeFileSync(join(hermetic.dir, "AGENTS.md"), "# Project rules\n\nPROJECT-AGENTS-MD-17\n");
    let childPrompt = "";
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "scout", prompt: "look", description: "scout" }),
        parentFinal: "PARENT-FINAL",
        subagent: (ctx: Context) => {
          childPrompt = systemPromptOf(ctx);
          return "SCOUT-ANSWER";
        },
      }),
    });
    expect(agentToolResults(run.parentSession)).toEqual(["SCOUT-ANSWER"]);
    // pi's preamble survives: no wholesale system prompt override.
    expect(childPrompt).toContain("You are an expert coding assistant operating inside pi");
    // The persona rides in the addendum behind the active-agent tag.
    expect(childPrompt).toMatch(/<addendum>[\s\S]*<active_agent name="scout"\/>[\s\S]*SCOUT-PERSONA-41[\s\S]*<\/addendum>/);
    // The cwd's AGENTS.md reaches the child.
    expect(childPrompt).toMatch(/<project_context>[\s\S]*PROJECT-AGENTS-MD-17[\s\S]*<\/project_context>/);
    // pi's rules section is present (tool guidelines live there).
    expect(childPrompt).toContain("<rules>");
  });
});
