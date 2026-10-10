import { Effect, Layer } from "effect";
import type { ChildSession } from "../../v2src/domain/child-session.js";
import { ParentContext, type ParentContextShape } from "../../v2src/services/parent-context.service.js";
import { SessionFactory, type SessionFactoryShape } from "../../v2src/services/session-factory.js";

/**
 * stub-session-factory.ts — the test seam that replaces the pi SessionFactory.
 *
 * open() hands out prebuilt child sessions in order, so a test drives the registry and the
 * Agent with a scripted session and never touches the pi SDK.
 */

/** A dummy ParentContext: create()'s call signature requires one, the stub factory ignores it. */
export const stubParentContext: ParentContextShape = {
  cwd: process.cwd(),
  sessionFile: undefined,
  model: undefined,
  modelRegistry: {} as ParentContextShape["modelRegistry"],
  agentDir: "",
};

/** Provide the ParentContext create() requires; the stub factory never reads it. */
export const withParentContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ParentContext>> =>
  Effect.provideService(effect, ParentContext, stubParentContext);

/** A SessionFactory layer whose open() returns the given child sessions in order. */
export const stubSessionFactory = (
  sessions: ChildSession | ReadonlyArray<ChildSession>,
): Layer.Layer<SessionFactory> => {
  const queue: ChildSession[] = Array.isArray(sessions) ? [...sessions] : [sessions as ChildSession];
  const shape: SessionFactoryShape = {
    open: () => {
      const next = queue.shift();
      return next === undefined ? Effect.die(new Error("stubSessionFactory: no session left")) : Effect.succeed(next);
    },
  };
  return Layer.succeed(SessionFactory, shape);
};
