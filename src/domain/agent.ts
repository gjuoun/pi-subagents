import { Clock, Effect, Ref } from "effect";
import type { ChildSession } from "./child-session.js";
import { type AgentBusy, type NotRunning, RegistryError, type RunFailed } from "./errors.js";

/**
 * agent.ts — one subagent: its own child session and its published state.
 *
 * The Agent owns a Ref<AgentSnapshot> and republishes every transition through the registry
 * read model, so the widget, the resume path and the e2e handle all read one plain-data view.
 * run() applies the busy guard, flips the record running, runs one prompt and settles it.
 */

export type AgentStatus = "queued" | "running" | "done" | "error" | "aborted";

/** The published, plain-data view of one agent. */
export interface AgentSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  /** Typeable handle (name, else type; numbered on collision) — tools accept it for the id. */
  readonly handle: string;
  readonly description: string;
  readonly status: AgentStatus;
  readonly runs: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly lastText: string;
  readonly toolUses: number;
  readonly lastTool?: string;
  /** Turns the latest run took. */
  readonly turns: number;
  /** The latest run hit its turn cap and was steered to wrap up. */
  readonly wrappedUp: boolean;
  /** Model id the child runs on. */
  readonly model?: string;
  /** Thinking level the child runs at. */
  readonly thinking?: string;
  /** Lifetime tokens (input + output + cache writes). */
  readonly tokens: number;
  /** Context-window use, percent. */
  readonly contextPercent?: number;
  /** Badge colour from the agent file, as written. */
  readonly color?: string;
}

/** The note a run stopped at its turn limit carries after its partial answer. */
export const TURN_LIMIT_NOTE = "Stopped: the agent reached its turn limit before finishing.";

/** Everything needed to build an Agent; the registry supplies `publish`. */
export interface AgentInit {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly handle: string;
  readonly description: string;
  readonly color?: string;
  readonly session: ChildSession;
  /** Write one snapshot into the registry read model. */
  readonly publish: (snapshot: AgentSnapshot) => Effect.Effect<void>;
}

export class Agent {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly handle: string;
  readonly description: string;
  readonly #session: ChildSession;
  readonly #state: Ref.Ref<AgentSnapshot>;
  readonly #active: Ref.Ref<boolean>;
  readonly #publish: (snapshot: AgentSnapshot) => Effect.Effect<void>;
  /** Steers sent while queued, delivered with the prompt when the run starts. */
  #pendingSteers: string[] = [];

  private constructor(init: AgentInit, state: Ref.Ref<AgentSnapshot>, active: Ref.Ref<boolean>) {
    this.id = init.id;
    this.type = init.type;
    this.name = init.name;
    this.handle = init.handle;
    this.description = init.description;
    this.#session = init.session;
    this.#state = state;
    this.#active = active;
    this.#publish = init.publish;
  }

  /** Build an agent and publish its initial (running) snapshot. */
  static make(init: AgentInit): Effect.Effect<Agent> {
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const initial: AgentSnapshot = {
        id: init.id,
        type: init.type,
        name: init.name,
        handle: init.handle,
        description: init.description,
        status: "running",
        runs: 0,
        startedAt,
        lastText: "",
        toolUses: 0,
        turns: 0,
        wrappedUp: false,
        model: init.session.modelId,
        thinking: init.session.thinking,
        tokens: 0,
        ...(init.color !== undefined && { color: init.color }),
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
        return yield* Effect.fail(RegistryError.AgentBusy({ id: this.id, name: this.name }));
      }
      const startedAt = yield* Clock.currentTimeMillis;
      yield* this.#transition((s) => ({
        ...s,
        status: "running" as const,
        startedAt,
        finishedAt: undefined,
        lastTool: undefined,
        turns: 0,
        wrappedUp: false,
      }));

      let toolUses = 0;
      let lastTool: string | undefined;
      const steers = this.#pendingSteers.splice(0);
      const input = steers.length === 0 ? prompt : [prompt, ...steers].join("\n\n");
      const outcome = yield* this.#session
        .prompt(
          input,
          (tool) => {
            toolUses += 1;
            lastTool = tool;
            Effect.runSync(this.#transition((s) => ({ ...s, toolUses, lastTool })));
          },
          (usage) => {
            Effect.runSync(
              this.#transition((s) => ({
                ...s,
                tokens: usage.tokens,
                ...(usage.contextPercent !== undefined && { contextPercent: usage.contextPercent }),
              })),
            );
          },
        )
        .pipe(
          // A rejected prompt or a failed final turn must not leave the record running forever
          // — that would keep hasRunning() true (waitForAll hangs, resume returns AgentBusy).
          Effect.tapErrorTag("RunFailed", (error) =>
            Effect.gen({ self: this }, function* () {
              const finishedAt = yield* Clock.currentTimeMillis;
              yield* this.#transition((s) => ({
                ...s,
                status: "error" as const,
                finishedAt,
                runs: s.runs + 1,
                lastText: error.reason,
                toolUses,
                lastTool,
              }));
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.gen({ self: this }, function* () {
              const finishedAt = yield* Clock.currentTimeMillis;
              yield* this.#transition((s) => ({ ...s, status: "aborted" as const, finishedAt }));
              yield* Effect.sync(() => this.#session.abort());
            }),
          ),
          Effect.ensuring(Ref.set(this.#active, false)),
        );

      const finishedAt = yield* Clock.currentTimeMillis;
      // A run that ran out its grace window settles aborted, keeping whatever it had written.
      const answer = outcome.hardStopped
        ? [outcome.answer, TURN_LIMIT_NOTE].filter((s) => s.trim()).join("\n\n")
        : outcome.answer;
      yield* this.#transition((s) => ({
        ...s,
        status: outcome.hardStopped ? ("aborted" as const) : ("done" as const),
        finishedAt,
        runs: s.runs + 1,
        lastText: answer,
        toolUses: outcome.toolUses,
        lastTool: outcome.lastTool,
        turns: outcome.turns,
        wrappedUp: outcome.wrappedUp,
      }));
      return answer;
    });
  }

  /**
   * Steer the agent: into the running turn after its current tool call, or — while queued —
   * with its prompt when it starts. A settled agent cannot be steered.
   */
  steer(message: string): Effect.Effect<"sent" | "queued", NotRunning | RunFailed> {
    return Effect.gen({ self: this }, function* () {
      if (yield* Ref.get(this.#active)) {
        yield* this.#session.steer(message);
        return "sent" as const;
      }
      const status = (yield* Ref.get(this.#state)).status;
      if (status === "queued") {
        this.#pendingSteers.push(message);
        return "queued" as const;
      }
      return yield* Effect.fail(RegistryError.NotRunning({ id: this.id, status }));
    });
  }

  /** Publish that this agent waits for a background pool slot. */
  markQueued(): Effect.Effect<void> {
    return this.#transition((s) => ({ ...s, status: "queued" as const }));
  }

  abort(): Effect.Effect<void> {
    return Effect.sync(() => this.#session.abort());
  }

  dispose(): Effect.Effect<void> {
    return Effect.sync(() => this.#session.dispose());
  }
}
