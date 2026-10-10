import { Context, type Effect } from "effect";
import type { ChildSession, SpawnSpec } from "../domain/child-session.js";
import type { SessionError } from "../domain/errors.js";
import type { ParentContext } from "./parent-context.service.js";

/**
 * session-factory.ts — the port that opens a child session.
 *
 * The registry depends on this, never on the pi SDK: the live layer (pi/pi-session-factory.ts)
 * builds a real pi session, and tests provide a stub.
 */

export interface SessionFactoryShape {
  /** Open a child session for the given spec. */
  readonly open: (spec: SpawnSpec) => Effect.Effect<ChildSession, SessionError, ParentContext>;
}

export class SessionFactory extends Context.Service<SessionFactory, SessionFactoryShape>()(
  "pi-subagents/v2/SessionFactory",
) {}
