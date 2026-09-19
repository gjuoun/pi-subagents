/**
 * index.ts — the extension entry: the child-session guard, one call, and two re-exports.
 *
 * This file's PATH is load-bearing. `extensionCanonicalName` maps `index.ts` to its parent
 * directory name, so `./src/index.ts` canonicalises to the user-facing allowlist token `src`
 * that agent frontmatter writes as `extensions: [src]`, `exclude_extensions: [src]` and
 * `tools: ext:src`. Moving it would silently stop every one of those selectors matching —
 * `test/entry-manifest.test.ts` is what catches that.
 *
 * Everything the extension does lives in src/app.ts (the composition root) and the domains it
 * wires. This file exists to answer pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "./app.js";
import { inChildSessionContext } from "./lib/child-context.js";

/**
 * Re-exported because a test imports them from `src/index.js` (test/workflow-tool.test.ts).
 * Nothing else is forwarded: the other names that used to be re-exported here had no consumer
 * left — they were kept alive by a test file that no longer exists.
 */
export { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "./workflow/run/entry.js";

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there would create
  // another manager and leak handlers. Nested orchestration is injected as scoped custom tools
  // by the existing manager instead.
  if (inChildSessionContext()) return;
  createExtension(pi);
}
