/**
 * handle.ts — the typeable handle an agent is addressed by (name, else type).
 *
 * Lowercased, non-word runs collapsed to "-"; collisions numbered `scout`, `scout-2`, …
 * "main" is reserved (it names the parent conversation in @mentions).
 */

export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

/** The slug a name or type contributes. */
export function handleBase(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agent";
}

/** `base`, else `base-2`, `base-3`, … — the first form neither taken nor reserved. */
export function assignHandle(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 1;
  while (taken.has(candidate) || RESERVED_HANDLES.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}
