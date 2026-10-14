import { describe, expect, it } from "vitest";
import v2Extension from "../src/index.js";
import { makePi } from "./helpers/boot-extension.js";

/**
 * boot.test.ts — the extension boots against a mock pi and registers exactly the slim surface
 * (JW-166): three tools and one command.
 */
describe("v2 extension boot", () => {
  it("boots the factory against a mock pi without throwing", () => {
    const { pi } = makePi();
    expect(() => v2Extension(pi)).not.toThrow();
  });

  it("registers exactly Agent, get_subagent_result and steer_subagent, and /agents", () => {
    const { pi, tools, commands } = makePi();
    v2Extension(pi);
    expect([...tools.keys()].sort()).toEqual(["Agent", "get_subagent_result", "steer_subagent"]);
    expect([...commands.keys()]).toEqual(["agents"]);
  });
});
