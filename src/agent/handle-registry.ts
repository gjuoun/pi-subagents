/**
 * handle-registry.ts — what a `@handle` is called, and how one gets allocated.
 *
 * Split out of `mention/mention.ts`, which held this beside the mention GRAMMAR (the trigger,
 * the send form, the reminder and the parser). The two are different jobs with different callers:
 * the manager allocates handles when it spawns, and never parses a mention; the dispatcher parses
 * mentions and resolves what it finds against this. Only the allocation half moved.
 *
 * `handleBase` is the single source of truth in both directions — a type is addressable by exactly
 * the handle its instances are given — which is why allocation and the type lookup share a module.
 */

/**
 * Upper bound on a handle, matching Claude Code's `dSS`. Nothing here generates
 * a name this long, but an agent type or a model-supplied name can be arbitrary
 * text, and an unbounded handle would wrap the suggestion popup.
 */
const MAX_HANDLE_LENGTH = 64;

/**
 * Handles that address something other than a subagent, and so can never be
 * allocated to one. Claude Code reserves exactly this name (`Vq = "main"`),
 * refusing it at spawn and routing it to the main conversation instead.
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

/** Whether `@handle` names the main conversation rather than any subagent. */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

/** Slug of an agent type or name, restricted to the `[\w-]` the grammar allows. */
export function handleBase(type: string): string {
  const slug = type.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LENGTH)
    // The slice can land mid-run and leave the trailing hyphen back.
    .replace(/-+$/, "");
  return slug || "agent";
}

/**
 * `base`, else `base-2`, `base-3`, … — the first form that is neither `taken`
 * nor reserved. Callers pass one shared `taken` set covering type-derived
 * handles and model-supplied aliases alike, so the two can never collide.
 */
export function assignHandle(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 1;
  while (taken.has(candidate) || RESERVED_HANDLES.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/**
 * Map a typed handle back to a registered agent type, so `@explore fix it`
 * reaches the Explore agent even when no instance has ever run. `handleBase` is
 * the single source of truth in both directions, so a type is addressable by
 * exactly the handle its instances would be given.
 */
export function resolveHandleToType(handle: string, types: readonly string[]): string | undefined {
  const wanted = handle.toLowerCase();
  // A type slugging to a reserved name is unaddressable rather than shadowing
  // it — `assignHandle` refuses that name too, so its instances never hold one.
  if (RESERVED_HANDLES.has(wanted)) return undefined;
  return types.find(type => handleBase(type) === wanted);
}
