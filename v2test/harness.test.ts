import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runV2, type V2Run } from "./helpers/v2-runner.js";

/**
 * harness.test.ts — proves the v2 faux e2e harness drives a real pi turn.
 *
 * Step 4 asserts only that the plumbing works: a scripted parent reply comes back
 * as responseText, and persist:true writes exactly one parent .jsonl.
 */
describe("v2 faux e2e harness", () => {
  let run: V2Run | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("drives a real faux parent turn and persists the parent session", async () => {
    run = await runV2({ prompt: "say hello", persist: true, respond: () => "HELLO-V2" });

    expect(run.responseText).toBe("HELLO-V2");
    expect(run.sessionDir).toBeDefined();

    const files = readdirSync(run.sessionDir as string).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const sessionFile = join(run.sessionDir as string, files[0]);
    expect(run.parentSessionFile).toBe(sessionFile);
  });
});
