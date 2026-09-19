/**
 * errors.ts — the model-resolution failure domain.
 *
 * One code, deliberately: there is exactly one way resolving a model fails (the
 * input names nothing this registry can reach) and one decision hanging off it
 * (fall back to the parent, or tell the caller). A per-step code would encode
 * *why* a step missed, which no consumer branches on — so the catalog keeps the
 * single variant a caller can act on.
 *
 * The catalog is built by {@link autoTag}, so the object key IS the runtime
 * `code` — see `lib/result.ts` for the helper and why errors here are plain
 * data rather than an `Error` subclass.
 */

import { autoTag, type FactoryUnion } from "../lib/result.js";

/**
 * `message` is the caller-facing account and is quoted verbatim in
 * `docs/rpc.md`; `input` and `available` are the same facts as data, so a
 * consumer can render its own view (or log them) without re-parsing prose.
 */
export const modelError = autoTag({
  NOT_FOUND: (input: string, available: string[]) => ({
    message: `Model not found: "${input}".\n\nAvailable models:\n${available.map(model => `  ${model}`).join("\n")}`,
    input,
    available,
  }),
});

/** Every way `resolveModel` can fail. */
export type ModelFailure = FactoryUnion<typeof modelError>;
