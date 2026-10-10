import { Data } from "effect";

/**
 * errors.ts — the closed catalog of expected failures for v2src.
 *
 * Everything inside v2src fails with one of these tagged errors; nothing else
 * crosses the pi boundary. The `_tag` is the stable, plain-string code the boundary
 * prints and the e2e harness matches on, and each error owns its own human message
 * via `plain`.
 */

/** The plain, JSON-serializable shape that may cross into pi. */
export interface PlainError {
  readonly code: string;
  readonly message: string;
}

export class UnknownAgentType extends Data.TaggedError("UnknownAgentType")<{
  readonly requested: string;
  readonly available: ReadonlyArray<string>;
}> {
  get plain(): PlainError {
    return {
      code: this._tag,
      message: `Unknown agent type "${this.requested}". Available: ${this.available.join(", ")}`,
    };
  }
}

export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{
  readonly id: string;
}> {
  get plain(): PlainError {
    return { code: this._tag, message: `Agent "${this.id}" not found` };
  }
}

export class AgentBusy extends Data.TaggedError("AgentBusy")<{
  readonly id: string;
  readonly name: string;
}> {
  get plain(): PlainError {
    return { code: this._tag, message: `Agent "${this.name}" (${this.id}) is busy` };
  }
}

export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly reason: string;
}> {
  get plain(): PlainError {
    return { code: this._tag, message: `Failed to spawn agent: ${this.reason}` };
  }
}

export class RunFailed extends Data.TaggedError("RunFailed")<{
  readonly id: string;
  readonly reason: string;
}> {
  get plain(): PlainError {
    return { code: this._tag, message: `Agent "${this.id}" failed: ${this.reason}` };
  }
}

export type V2Error = UnknownAgentType | AgentNotFound | AgentBusy | SpawnFailed | RunFailed;
