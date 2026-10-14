import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticDir } from "./helpers/boot-extension.js";
import { agentCall, routeBySession, runV2, toolNamesOf, type V2Run } from "./helpers/v2-runner.js";

/**
 * child-tools.test.ts — the decided tools rule (JW-166 Step 6): `tools` omitted gives the
 * child every registered tool (built-ins + extension tools); `tools` set gives exactly the
 * listed built-ins plus `ext:<ext>` / `ext:<ext>/<tool>` selections; the three subagent
 * tools never reach a child. A project extension `fx` registers fx_alpha, fx_beta and a
 * decoy named get_subagent_result to prove the denylist.
 */

const FX_EXTENSION = [
  "export default function (pi) {",
  '  for (const name of ["fx_alpha", "fx_beta", "get_subagent_result"]) {',
  "    pi.registerTool({",
  "      name,",
  "      label: name,",
  '      description: name + " tool",',
  '      parameters: { type: "object", properties: {} },',
  '      execute: async () => ({ content: [{ type: "text", text: name }] }),',
  "    });",
  "  }",
  "}",
  "",
].join("\n");

const agentFile = (tools?: string) =>
  ["---", "name: scout", "description: A scout", ...(tools ? [`tools: ${tools}`] : []), "---", "SCOUT"].join("\n");

const SUBAGENT_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

describe("v2 child tools rule", () => {
  let run: V2Run | undefined;
  let hermetic: ReturnType<typeof hermeticDir> | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  async function childToolsFor(tools?: string): Promise<string[]> {
    hermetic = hermeticDir({ agentFiles: { scout: agentFile(tools) } });
    mkdirSync(join(hermetic.dir, ".pi", "extensions", "fx"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "extensions", "fx", "index.ts"), FX_EXTENSION);
    let seen: string[] = [];
    run = await runV2({
      cwd: hermetic.dir,
      prompt: "delegate",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "scout", prompt: "look", description: "scout" }),
        parentFinal: "PARENT-FINAL",
        subagent: (ctx: Context) => {
          seen = toolNamesOf(ctx);
          return "OK";
        },
      }),
    });
    return seen;
  }

  it("omitted tools gives every registered tool", async () => {
    const seen = await childToolsFor();
    for (const t of ["read", "bash", "edit", "write", "grep", "find", "ls", "fx_alpha", "fx_beta"]) {
      expect(seen).toContain(t);
    }
    for (const t of SUBAGENT_TOOLS) expect(seen).not.toContain(t);
  });

  it("tools: read gives only read", async () => {
    expect(await childToolsFor("read")).toEqual(["read"]);
  });

  it("tools: read, ext:fx/fx_alpha gives read and that one extension tool", async () => {
    expect((await childToolsFor("read, ext:fx/fx_alpha")).sort()).toEqual(["fx_alpha", "read"]);
  });

  it("tools: ext:fx gives all of that extension's tools except the subagent tools", async () => {
    expect((await childToolsFor("ext:fx")).sort()).toEqual(["fx_alpha", "fx_beta"]);
  });
});
