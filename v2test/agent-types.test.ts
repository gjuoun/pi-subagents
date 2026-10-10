import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticDir } from "../test/helpers/boot-extension.js";
import { loadAgentTypes } from "../v2src/agent-types.js";
import { agentCall, agentToolResults, routeBySession, runV2, type V2Run } from "./helpers/v2-runner.js";

const SCOUT_TOOLS_READ = "---\nname: scout\ndescription: A scout\ntools: read\n---\nSCOUT-BODY-TEXT";

describe("v2 agent types from .md", () => {
  let run: V2Run | undefined;
  let hermetic: ReturnType<typeof hermeticDir> | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  it("(a)+(b) a project scout with tools:read offers only read and injects its body", async () => {
    hermetic = hermeticDir({ agentFiles: { scout: SCOUT_TOOLS_READ } });
    let childTools: string[] = [];
    let childSystemPrompt = "";
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "scout", prompt: "look", description: "scout" }),
        parentFinal: "PARENT-FINAL",
        subagent: (ctx: Context) => {
          childTools = (ctx.tools ?? []).map((t) => t.name);
          childSystemPrompt = ctx.systemPrompt ?? "";
          return "SCOUT-ANSWER";
        },
      }),
    });
    expect(agentToolResults(run.parentSession)).toEqual(["SCOUT-ANSWER"]);
    expect(childTools).toEqual(["read"]);
    expect(childSystemPrompt).toContain("SCOUT-BODY-TEXT");
  });

  it("(c) a project file overrides a same-named global file", async () => {
    hermetic = hermeticDir({ agentFiles: { scout: "---\nname: scout\ndescription: P\n---\nPROJECT-BODY" } });
    let childSystemPrompt = "";
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      beforeRun: () => {
        const globalDir = join(process.env.PI_CODING_AGENT_DIR as string, "agents");
        mkdirSync(globalDir, { recursive: true });
        writeFileSync(join(globalDir, "scout.md"), "---\nname: scout\ndescription: G\n---\nGLOBAL-BODY");
      },
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "scout", prompt: "look", description: "scout" }),
        parentFinal: "PARENT-FINAL",
        subagent: (ctx: Context) => {
          childSystemPrompt = ctx.systemPrompt ?? "";
          return "OK";
        },
      }),
    });
    expect(childSystemPrompt).toContain("PROJECT-BODY");
    expect(childSystemPrompt).not.toContain("GLOBAL-BODY");
  });

  it("(d) an unknown type lists the available types", async () => {
    hermetic = hermeticDir({ agentFiles: { scout: SCOUT_TOOLS_READ } });
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "nope", prompt: "x", description: "x" }),
        parentFinal: "PARENT-FINAL",
        subagent: "CHILD",
      }),
    });
    const text = agentToolResults(run.parentSession)[0];
    expect(text).toMatch(/^Error \[UnknownAgentType\]/);
    expect(text).toContain("general-purpose");
    expect(text).toContain("scout");
  });

  it("(e) a malformed .md does not stop the others loading", async () => {
    hermetic = hermeticDir({
      agentFiles: {
        scout: SCOUT_TOOLS_READ,
        broken: "---\nname: [unclosed\n---\nbroken body",
      },
    });
    const types = await Effect.runPromise(loadAgentTypes(hermetic.dir));
    const names = types.map((t) => t.name);
    expect(names).toContain("general-purpose");
    expect(names).toContain("scout");
    expect(names).not.toContain("broken");
  });
});
