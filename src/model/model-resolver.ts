/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

import type { Model } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "neverthrow";
import { type ModelFailure, modelError } from "./errors.js";

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/**
 * Resolve a model string to a Model instance.
 *
 * Three attempts, in order: an exact `provider/modelId` match, a fuzzy match
 * against the models that have auth, and — when the input named a provider that
 * turned out not to have the model — the same id under any other provider. Each
 * is a *recovery* from the previous one's miss, so they compose as an `.orElse`
 * chain; a `safeTry` generator would short-circuit on the first `Err` and never
 * reach the second attempt.
 *
 * Every failure is the same {@link modelError}.`NOT_FOUND` about `input`: the
 * domain has one code and one message, and the caller spelled the input, so the
 * answer is worded about what it spelled rather than about the attempt that
 * missed. The message text is quoted in `docs/rpc.md` — keep it verbatim.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): Result<Model<any>, ModelFailure> {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(entry => `${entry.provider}/${entry.id}`.toLowerCase()));
  const slashIdx = input.indexOf("/");
  // A miss answers the same way wherever it happens, and building the list is
  // the only cost of a failure: sorted here so a successful resolution never
  // pays for a message it will not show.
  const notFound = (): ModelFailure =>
    modelError.NOT_FOUND(input, all.map(entry => `${entry.provider}/${entry.id}`).sort());

  // A lookup answer as a Result: a found model is the attempt's success, and a
  // miss is the function's own not-found answer, which the next `.orElse`
  // recovers from.
  const attempt = (found: Model<any> | undefined): Result<Model<any>, ModelFailure> =>
    found ? ok(found) : err(notFound());

  return attempt(exactMatch(input, slashIdx, availableSet, registry))
    .orElse(() => attempt(fuzzyMatch(input, all, registry)))
    .orElse(() =>
      slashIdx === -1
        ? err(notFound())
        // Provider fallback: a "provider/modelId" query that didn't match under
        // the named provider (exact or fuzzy above) retries against all
        // providers. The named provider is preferred when present; this only
        // kicks in when it isn't, so the same model from another provider beats
        // falling back to "inherit".
        : resolveModel(input.slice(slashIdx + 1), registry),
    )
    // The recursive attempt words its failure about the *bare* id it was handed,
    // and the fuzzy step words its miss about nothing. The caller asked about
    // the input as spelled, so every path answers about that.
    .mapErr(() => notFound());
}

/**
 * Attempt 1 — exact match: "provider/modelId", and only when that exact model
 * is available (has auth). A name the registry knows but the user cannot reach
 * must not resolve: the spawn would fail on a missing API key.
 */
function exactMatch(
  input: string,
  slashIdx: number,
  availableSet: Set<string>,
  registry: ModelRegistry,
): Model<any> | undefined {
  if (slashIdx === -1) return undefined;
  if (!availableSet.has(input.toLowerCase())) return undefined;
  const provider = input.slice(0, slashIdx);
  const modelId = input.slice(slashIdx + 1);
  // The registry's own `find` is duck-typed (`ModelRegistry` is a structural
  // minimum — see the interface above), so the one cast in this module is here.
  return registry.find(provider, modelId) as Model<any> | undefined;
}

/**
 * Attempt 2 — fuzzy match against the available models. Normalize separators so
 * cosmetic punctuation differences still match — e.g. "claude-haiku-4.5" and
 * "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
 */
function fuzzyMatch(
  input: string,
  all: ModelEntry[],
  registry: ModelRegistry,
): Model<any> | undefined {
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    return registry.find(bestMatch.provider, bestMatch.id) as Model<any> | undefined;
  }
  return undefined;
}
