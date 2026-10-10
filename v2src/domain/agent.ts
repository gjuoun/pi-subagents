import { Effect, Ref } from "effect";
import type { ChildSession } from "../pi/pi-child-session.js";
import { AgentBusy, RunFailed } from "./errors.js";

/**
 * agent.ts — one subagent: its own child session and its published state.
 *
 * The Agent owns a Ref<AgentSnapshot> and republishes every transition through the registry
 * read model, so the widget, the resume path and the e2e handle all read one plain-data view.
 * run() applies the busy guard, flips the record running, runs one prompt and settles it.
 */

export type AgentStatus = "running" | "done" | "error" | "aborted";

/** The published, plain-data view of one agent. */
export interface AgentSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly status: AgentStatus;
  readonly runs: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly lastText: string;
  readonly toolUses: number;
  readonly lastTool?: string;
}

/** Everything needed to build an Agent; the registry supplies `publish`. */
export interface AgentInit {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly session: ChildSession;
  /** Write one snapshot into the registry read model. */
  readonly publish: (snapshot: AgentSnapshot) => Effect.Effect<void>;
}

export class Agent {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly #session: ChildSession;
  readonly #state: Ref.Ref<AgentSnapshot>;
  readonly #active: Ref.Ref<boolean>;
  readonly #publish: (snapshot: AgentSnapshot) => Effect.Effect<void>;

  private constructor(init: AgentInit, state: Ref.Ref<AgentSnapshot>, active: Ref.Ref<boolean>) {
    this.id = init.id;
    this.type = init.type;
    this.name = init.name;
    this.description = init.description;
    this.#session = init.session;
    this.#state = state;
    this.#active = active;
    this.#publish = init.publish;
  }

  /** Build an agent and publish its initial (running) snapshot. */
  static make(init: AgentInit): Effect.Effect<Agent> {
    return Effect.gen(function* () {
      const initial: AgentSnapshot = {
        id: init.id,
        type: init.type,
        name: init.name,
        description: init.description,
        status: "running",
        runs: 0,
        startedAt: Date.now(),
        lastText: "",
        toolUses: 0,
      };
      const state = yield* Ref.make(initial);
      const active = yield* Ref.make(false);
      yield* init.publish(initial);
      return new Agent(init, state, active);
    });
  }

  /** "<type>#<id8>" — matches the child session name. */
  get label(): string {
    return `${this.type}#${this.id.slice(0, 8)}`;
  }

  get session(): ChildSession {
    return this.#session;
  }

  /** Immutable snapshot of the agent's published state. */
  get snapshot(): Effect.Effect<AgentSnapshot> {
    return Ref.get(this.#state);
  }

  /** True while a run is in flight (an agent created but not yet run is not running). */
  get isRunning(): Effect.Effect<boolean> {
    return Ref.get(this.#active);
  }

  /** The one place a transition updates both the owner Ref and the registry read model. */
  #transition(f: (snapshot: AgentSnapshot) => AgentSnapshot): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const next = yield* Ref.updateAndGet(this.#state, f);
      yield* this.#publish(next);
    });
  }

  /**
   * Run one prompt: fail AgentBusy if a run is in flight, else flip running, run, and settle.
   * A rejected prompt or failed final turn marks the record error, so it never stays running.
   * Interruption marks the record aborted and aborts the child session.
   */
  run(prompt: string): Effect.Effect<string, RunFailed | AgentBusy> {
    return Effect.gen({ self: this }, function* () {
      // Atomic claim: getAndSet flips the latch and returns the previous value in one step, so
      // two fibers resuming the same agent cannot both pass the guard. On a loss the latch was
      // already true — leave it for the in-flight run to clear.
      if (yield* Ref.getAndSet(this.#active, true)) {
        return yield* Effect.fail(new AgentBusy({ id: this.id, name: this.name }));
      }
      yield* this.#transition((s) => ({
        ...s,
        status: "running" as const,
        startedAt: Date.now(),
        finishedAt: undefined,
        lastTool: undefined,
      }));

      let toolUses = 0;
      let lastTool: string | undefined;
      const outcome = yield* this.#session
        .prompt(prompt, (tool) => {
          toolUses += 1;
          lastTool = tool;
        })
        .pipe(
          // A rejected prompt or a failed final turn must not leave the record running forever
          // — that would keep hasRunning() true (waitForAll hangs, resume returns AgentBusy).
          Effect.tapErrorTag("RunFailed", () =>
            this.#transition((s) => ({
              ...s,
              status: "error" as const,
              finishedAt: Date.now(),
              runs: s.runs + 1,
              toolUses,
              lastTool,
            })),
          ),
          Effect.onInterrupt(() =>
            Effect.gen({ self: this }, function* () {
              yield* this.#transition((s) => ({ ...s, status: "aborted" as const, finishedAt: Date.now() }));
              yield* Effect.sync(() => this.#session.abort());
            }),
          ),
          Effect.ensuring(Ref.set(this.#active, false)),
        );

      yield* this.#transition((s) => ({
        ...s,
        status: "done" as const,
        finishedAt: Date.now(),
        runs: s.runs + 1,
        lastText: outcome.answer,
        toolUses: outcome.toolUses,
        lastTool: outcome.lastTool,
      }));
      return outcome.answer;
    });
  }

  abort(): Effect.Effect<void> {
    return Effect.sync(() => this.#session.abort());
  }

  dispose(): Effect.Effect<void> {
    return Effect.sync(() => this.#session.dispose());
  }
}
