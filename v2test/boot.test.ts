import { describe, expect, it } from "vitest";
import { makePi } from "../test/helpers/boot-extension.js";
import v2Extension from "../v2src/index.js";

/**
 * boot.test.ts — the v2 scaffold boots against a mock pi without throwing.
 */
describe("v2 extension boot", () => {
  it("boots the factory against a mock pi without throwing", () => {
    const { pi } = makePi();
    expect(() => v2Extension(pi)).not.toThrow();
  });
});
