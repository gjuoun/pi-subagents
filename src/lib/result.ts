/**
 * result.ts — the shared construction path for this extension's failure domains.
 *
 * Two concerns live here, both domain-free on purpose:
 *
 *   - {@link autoTag} turns a plain object of factories into a *catalog* — the
 *     object key IS the runtime `code`, written once instead of repeated inside
 *     every factory body, and spread in last so a mis-typed payload cannot
 *     overwrite it.
 *   - {@link FactoryUnion} derives the failure union from that catalog, so adding
 *     a variant cannot leave the type behind.
 *
 * Errors built this way are plain data (`{ code, message, … }`), never classes:
 * an extension error crosses no HTTP boundary, is consumed in-process by our own
 * code, and so is better off narrowing by `code` than by `instanceof`, and being
 * `JSON.stringify`-safe for free.
 *
 * A catalog is declared next to the failure it models (e.g. `model/errors.ts`),
 * not here — one union per failure domain.
 */

/** A catalog entry: returns at least a message, and never its own `code`. */
type Spec = (...args: never[]) => { message: string; code?: never };

/** A catalog whose entries have had their `code` injected by {@link autoTag}. */
export type AutoTagged<M extends Record<string, Spec>> = {
  [K in keyof M]: (...args: Parameters<M[K]>) => { code: K } & Omit<ReturnType<M[K]>, "code">;
};

/** Turn a plain object of factories into a catalog keyed by the `code` it stamps. */
export const autoTag = <M extends Record<string, Spec>>(map: M): AutoTagged<M> =>
  Object.fromEntries(
    Object.entries(map).map(([code, factory]) => [
      code,
      (...args: never[]) => ({ ...factory(...args), code }),
    ]),
  ) as unknown as AutoTagged<M>;

/** The failure union a catalog describes — one variant per entry. */
export type FactoryUnion<M extends Record<string, (...args: never[]) => unknown>> =
  ReturnType<M[keyof M]>;
