import { Data } from "effect";

/**
 * errors.ts — the closed catalog of expected failures for src, scoped by area.
 *
 * Three `Data.TaggedEnum`s: SessionError (spawn/run), RegistryError (lookup/busy) and
 * CatalogError (type resolution). The `_tag` is the stable plain-string code the boundary
 * prints as `Error [<Tag>]: <message>` and the e2e harness matches on. Each area owns one
 * exhaustive `$match` renderer, and `renderError` dispatches to the scoped renderer.
 */

export type SessionError = Data.TaggedEnum<{
  SpawnFailed: { readonly reason: string };
  RunFailed: { readonly id: string; readonly reason: string };
  /** A `model` (param or frontmatter) that is not an exact provider/id in the registry. */
  UnknownModel: { readonly model: string; readonly agent: string };
  /** subagent_type "fork" from a parent with no session file to branch. */
  ForkUnavailable: { readonly reason: string };
}>;

export const SessionError = Data.taggedEnum<SessionError>();

/** The single SpawnFailed variant. */
export type SpawnFailed = Extract<SessionError, { _tag: "SpawnFailed" }>;
/** The single RunFailed variant. */
export type RunFailed = Extract<SessionError, { _tag: "RunFailed" }>;
/** The single UnknownModel variant. */
export type UnknownModel = Extract<SessionError, { _tag: "UnknownModel" }>;

export type RegistryError = Data.TaggedEnum<{
  AgentNotFound: { readonly id: string };
  AgentBusy: { readonly id: string; readonly name: string };
  /** steer_subagent on an agent that is not running. */
  NotRunning: { readonly id: string; readonly status: string };
}>;

export const RegistryError = Data.taggedEnum<RegistryError>();

/** The single AgentNotFound variant. */
export type AgentNotFound = Extract<RegistryError, { _tag: "AgentNotFound" }>;
/** The single AgentBusy variant. */
export type AgentBusy = Extract<RegistryError, { _tag: "AgentBusy" }>;
/** The single NotRunning variant. */
export type NotRunning = Extract<RegistryError, { _tag: "NotRunning" }>;

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
  UnknownModel: (error) =>
    `Unknown model "${error.model}" for agent "${error.agent}": use an exact provider/modelId from the model registry`,
  ForkUnavailable: (error) => `Cannot fork: ${error.reason}`,
});

/** The human message for a registry failure. */
export const renderRegistryError = RegistryError.$match({
  AgentNotFound: (error) => `Agent "${error.id}" not found`,
  AgentBusy: (error) => `Agent "${error.name}" (${error.id}) is busy`,
  NotRunning: (error) => `Agent "${error.id}" is not running (status: ${error.status}); only a running agent can be steered`,
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
    case "UnknownModel":
    case "ForkUnavailable":
      return renderSessionError(error);
    case "AgentNotFound":
    case "AgentBusy":
    case "NotRunning":
      return renderRegistryError(error);
    case "UnknownAgentType":
      return renderCatalogError(error);
  }
}
