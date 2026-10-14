import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentMentionReminder, type MentionRoster, mentionItems, transformMention } from "../src/domain/mention.js";
import { createMentionProvider } from "../src/ui/mention-completion.js";
import { isParentCall, runV2, type V2Run } from "./helpers/v2-runner.js";

/** mention.test.ts — the @mention reminder and @ completion (JW-166 Step 12). */

const roster: MentionRoster = {
  live: [{ id: "abcd1234", handle: "auth-audit", type: "finder", status: "running", description: "audit auth" }],
  types: [
    { name: "finder", description: "Search the code. Second sentence." },
    { name: "worker", description: "Implements things." },
  ],
};

describe("v2 mention transform", () => {
  it("appends Claude Code's reminder for an agent type", () => {
    expect(transformMention("@finder look at the RPC path", roster)).toBe(
      `look at the RPC path\n\n${agentMentionReminder("finder")}`,
    );
  });

  it("accepts the @agent- spelling", () => {
    expect(transformMention("@agent-worker build it", roster)).toContain('invoke the agent "worker"');
  });

  it("tells the model to steer a running named agent", () => {
    const out = transformMention("@auth-audit also check tokens", roster);
    expect(out).toContain("also check tokens");
    expect(out).toContain('steer_subagent (agent_id "auth-audit")');
  });

  it("tells the model to resume a finished agent", () => {
    const done = { ...roster, live: [{ ...roster.live[0], status: "done" }] };
    expect(transformMention("@auth-audit more", done)).toContain('resume "abcd1234"');
  });

  it("strips @main", () => {
    expect(transformMention("@main @finder is not a mention", roster)).toBe("@finder is not a mention");
  });

  it("leaves anything else untouched", () => {
    expect(transformMention("@nobody hi", roster)).toBeUndefined();
    expect(transformMention("hey @finder look", roster)).toBeUndefined();
    expect(transformMention("@finder", roster)).toBeUndefined();
    expect(transformMention("@src/index.ts explain", roster)).toBeUndefined();
  });
});

describe("v2 mention completion", () => {
  it("lists live handles first, then types, by prefix", () => {
    const all = mentionItems(roster, "@", 1);
    expect(all?.items.map((i) => i.value)).toEqual(["@auth-audit", "@finder", "@worker"]);
    expect(all?.items[0].description).toBe("send message · running · audit auth");
    expect(all?.items[1].description).toBe("start agent · Search the code.");
    expect(mentionItems(roster, "ask @fi", 7)?.items.map((i) => i.value)).toEqual(["@finder"]);
    expect(mentionItems(roster, "no mention", 10)).toBeNull();
  });

  it("puts agent rows ahead of the wrapped provider's rows", async () => {
    const inner = {
      getSuggestions: async () => ({ items: [{ value: "src/", label: "src/" }], prefix: "@" }),
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    };
    const provider = createMentionProvider(inner as never, async () => roster);
    const out = await provider.getSuggestions(["@w"], 0, 2, { signal: new AbortController().signal } as never);
    expect(out?.items.map((i) => i.value)).toEqual(["@worker", "src/"]);
  });
});

describe("v2 mention input hook (e2e)", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("delivers the reminder to the main model", async () => {
    let seen = "";
    run = await runV2({
      prompt: "@worker summarize the repo",
      respond: (ctx: Context) => {
        if (isParentCall(ctx) && seen === "") {
          seen = ctx.messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")))
            .join("\n");
        }
        return "PARENT-FINAL";
      },
    });
    expect(seen).toContain("summarize the repo");
    expect(seen).toContain('The user has expressed a desire to invoke the agent "worker"');
    expect(seen).not.toContain("@worker");
  });
});
