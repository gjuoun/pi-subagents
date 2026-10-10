import { Data } from "effect";

/**
 * errors.ts — the closed catalog of expected failures for v2src, scoped by area.
 *
 * Three `Data.TaggedEnum`s: SessionError (spawn/run), RegistryError (lookup/busy) and
 * CatalogError (type resolution). The `_tag` is the stable plain-string code the boundary
 * prints as `Error [<Tag>]: <message>` and the e2e harness matches on. Each area owns one
 * exhaustive `$match` renderer, and `renderError` dispatches to the scoped renderer.
 */

export type SessionError = Data.TaggedEnum<{
  SpawnFailed: { readonly reason: string };
  RunFailed: { readonly id: string; readonly reason: string };
}>;

export const SessionError = Data.taggedEnum<SessionError>();

/** The single SpawnFailed variant. */
export type SpawnFailed = Extract<SessionError, { _tag: "SpawnFailed" }>;
/** The single RunFailed variant. */
export type RunFailed = Extract<SessionError, { _tag: "RunFailed" }>;

export type RegistryError = Data.TaggedEnum<{
  AgentNotFound: { readonly id: string };
  AgentBusy: { readonly id: string; readonly name: string };
}>;

export const RegistryError = Data.taggedEnum<RegistryError>();

/** The single AgentNotFound variant. */
export type AgentNotFound = Extract<RegistryError, { _tag: "AgentNotFound" }>;
/** The single AgentBusy variant. */
export type AgentBusy = Extract<RegistryError, { _tag: "AgentBusy" }>;

export type CatalogError = Data.TaggedEnum<{
  UnknownAgentType: { readonly requested: string; readonly available: ReadonlyArray<string> };
}>;

export const CatalogError = Data.taggedEnum<CatalogError>();

/** The single UnknownAgentType variant. */
export type UnknownAgentType = Extract<CatalogError, { _tag: "UnknownAgentType" }>;

export type V2Error = SessionError | RegistryError | CatalogError;

/** The human message for a session failure. */
export const renderSessionError = SessionError.$match({
  SpawnFailed: (error) => `Failed to spawn agent: ${error.reason}`,
  RunFailed: (error) => `Agent "${error.id}" failed: ${error.reason}`,
});

/** The human message for a registry failure. */
export const renderRegistryError = RegistryError.$match({
  AgentNotFound: (error) => `Agent "${error.id}" not found`,
  AgentBusy: (error) => `Agent "${error.name}" (${error.id}) is busy`,
});

/** The human message for a catalog failure. */
export const renderCatalogError = CatalogError.$match({
  UnknownAgentType: (error) => `Unknown agent type "${error.requested}". Available: ${error.available.join(", ")}`,
});

/** Dispatch to the renderer for the area that raised the error. */
export function renderError(error: V2Error): string {
  switch (error._tag) {
    case "SpawnFailed":
    case "RunFailed":
      return renderSessionError(error);
    case "AgentNotFound":
    case "AgentBusy":
      return renderRegistryError(error);
    case "UnknownAgentType":
      return renderCatalogError(error);
  }
}
