/**
 * agent-meta.ts — the agent vocabulary that is not one domain's property.
 *
 * `THINKING_LEVELS` is pi's own advertised set, mirrored here so the Agent tool's description,
 * the generated-agent template and the `/agents` wizard can't drift behind pi again (#147).
 *
 * It started in `ui/agent-status.ts` (it was split out of `index.ts` with the status line) and
 * that is the wrong layer: the description builder that needs it lives in `agent/`, and
 * `agent → ui` is a layering violation. It is pure and has consumers on both sides of the tree,
 * which is what admits it here — the same rule that puts `SUBAGENT_TOOL_NAMES` in `tool-names.ts`.
 *
 * `formatToolsSuffix` did not come along: it needs `BUILTIN_TOOL_NAMES`, which `lib/` may not
 * reach into `config/` for. It lives with that list, in `config/registry/agent-types.ts`.
 */

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
