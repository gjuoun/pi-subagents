import { Data } from "effect";

/**
 * errors.ts — the closed catalog of expected failures for v2src.
 *
 * Everything inside v2src fails with one of these tagged errors; nothing else
 * crosses the pi boundary. The `_tag` is the stable, plain-string code the boundary
 * prints and the e2e harness matches on.
 */

export class UnknownAgentType extends Data.TaggedError("UnknownAgentType")<{
  readonly requested: string;
  readonly available: ReadonlyArray<string>;
}> {}

export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{
  readonly id: string;
}> {}

export class AgentBusy extends Data.TaggedError("AgentBusy")<{
  readonly id: string;
  readonly name: string;
}> {}

export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly reason: string;
}> {}

export class RunFailed extends Data.TaggedError("RunFailed")<{
  readonly id: string;
  readonly reason: string;
}> {}

export type V2Error = UnknownAgentType | AgentNotFound | AgentBusy | SpawnFailed | RunFailed;

/** The plain, JSON-serializable shape that may cross into pi. */
export interface PlainError {
  readonly code: string;
  readonly message: string;
}

export function toPlain(error: V2Error): PlainError {
  return { code: error._tag, message: errorMessage(error) };
}

function errorMessage(error: V2Error): string {
  switch (error._tag) {
    case "UnknownAgentType":
      return `Unknown agent type "${error.requested}". Available: ${error.available.join(", ")}`;
    case "AgentNotFound":
      return `Agent "${error.id}" not found`;
    case "AgentBusy":
      return `Agent "${error.name}" (${error.id}) is busy`;
    case "SpawnFailed":
      return `Failed to spawn agent: ${error.reason}`;
    case "RunFailed":
      return `Agent "${error.id}" failed: ${error.reason}`;
  }
}
