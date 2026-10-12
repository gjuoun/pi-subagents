import { randomBytes } from "node:crypto";
import { Context, Effect, Layer } from "effect";

/**
 * id-generator.ts — the port every agent id comes from.
 *
 * The registry never mints an id itself; tests provide a fixed generator, the live layer mints
 * an 8-hex-char id per call.
 */

export interface IdGeneratorShape {
  readonly next: () => Effect.Effect<string>;
}

export class IdGenerator extends Context.Service<IdGenerator, IdGeneratorShape>()(
  "pi-subagents/v2/IdGenerator",
) {
  static readonly random: Layer.Layer<IdGenerator> = Layer.succeed(IdGenerator, {
    next: () => Effect.sync(() => randomBytes(4).toString("hex")),
  });
}
