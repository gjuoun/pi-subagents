import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTypeCatalog } from "../src/services/agent-type-catalog.js";
import { ParentContext, type ParentContextShape } from "../src/services/parent-context.service.js";
import { hermeticDir } from "./helpers/boot-extension.js";
import { agentCall, agentToolResults, routeBySession, runV2, systemPromptOf, toolNamesOf, type V2Run } from "./helpers/v2-runner.js";

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
          childTools = toolNamesOf(ctx);
          childSystemPrompt = systemPromptOf(ctx);
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
          childSystemPrompt = systemPromptOf(ctx);
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
    expect(text).not.toContain("general-purpose");
    expect(text).toContain("scout");
  });

  it("(e) a malformed .md does not stop the others loading", async () => {
    hermetic = hermeticDir({
      agentFiles: {
        scout: SCOUT_TOOLS_READ,
        broken: "---\nname: [unclosed\n---\nbroken body",
      },
    });
    const parentContext: ParentContextShape = {
      cwd: hermetic.dir,
      sessionFile: undefined,
      model: undefined,
      modelRegistry: {} as ParentContextShape["modelRegistry"],
      agentDir: process.env.PI_CODING_AGENT_DIR as string,
    };
    const catalog = await Effect.runPromise(AgentTypeCatalog.make);
    const names = await Effect.runPromise(catalog.names().pipe(Effect.provideService(ParentContext, parentContext)));
    expect(names).toContain("scout");
    expect(names).not.toContain("broken");
  });
});

/** A ParentContext over the hermetic dirs, for driving the catalog directly. */
function hermeticParent(dir: string): ParentContextShape {
  return {
    cwd: dir,
    sessionFile: undefined,
    model: undefined,
    modelRegistry: {} as ParentContextShape["modelRegistry"],
    agentDir: process.env.PI_CODING_AGENT_DIR as string,
  };
}

describe("v2 agent catalog fields (JW-166)", () => {
  let hermetic: ReturnType<typeof hermeticDir> | undefined;
  afterEach(() => {
    hermetic?.restore();
    hermetic = undefined;
  });

  it("parses the 9 decided fields", async () => {
    hermetic = hermeticDir({
      agentFiles: {
        full: [
          "---",
          "name: full-agent",
          "description: Every field set",
          "model: faux/faux-1",
          "thinking: high",
          "tools: read, ext:jun_code, ext:fx/fx_alpha",
          "skills: false",
          "max_turns: 12",
          'color: "#F59E0B"',
          "enabled: true",
          "---",
          "FULL-BODY",
        ].join("\n"),
      },
    });
    const catalog = await Effect.runPromise(AgentTypeCatalog.make);
    const type = await Effect.runPromise(
      catalog.resolve("full-agent").pipe(Effect.provideService(ParentContext, hermeticParent(hermetic.dir))),
    );
    expect(type).toMatchObject({
      name: "full-agent",
      description: "Every field set",
      model: "faux/faux-1",
      thinking: "high",
      tools: ["read", "ext:jun_code", "ext:fx/fx_alpha"],
      skills: false,
      maxTurns: 12,
      color: "#F59E0B",
      enabled: true,
      systemPrompt: "FULL-BODY",
    });
  });

  it("defaults skills and enabled to true and leaves max_turns unlimited", async () => {
    hermetic = hermeticDir({ agentFiles: { scout: SCOUT_TOOLS_READ } });
    const catalog = await Effect.runPromise(AgentTypeCatalog.make);
    const type = await Effect.runPromise(
      catalog.resolve("scout").pipe(Effect.provideService(ParentContext, hermeticParent(hermetic.dir))),
    );
    expect(type.skills).toBe(true);
    expect(type.enabled).toBe(true);
    expect(type.maxTurns).toBeUndefined();
  });

  it("enabled:false is unknown", async () => {
    hermetic = hermeticDir({
      agentFiles: { scout: SCOUT_TOOLS_READ, hidden: "---\nname: hidden\nenabled: false\n---\nHIDDEN" },
    });
    const catalog = await Effect.runPromise(AgentTypeCatalog.make);
    const parent = hermeticParent(hermetic.dir);
    const exit = await Effect.runPromiseExit(catalog.resolve("hidden").pipe(Effect.provideService(ParentContext, parent)));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("UnknownAgentType");
    const names = await Effect.runPromise(catalog.names().pipe(Effect.provideService(ParentContext, parent)));
    expect(names).toEqual(["scout"]);
  });

  it("no built-in general-purpose", async () => {
    hermetic = hermeticDir({});
    const catalog = await Effect.runPromise(AgentTypeCatalog.make);
    const names = await Effect.runPromise(
      catalog.names().pipe(Effect.provideService(ParentContext, hermeticParent(hermetic.dir))),
    );
    expect(names).not.toContain("general-purpose");
  });
});
