/**
 * jev.ts — the `jev` agent-selector tool.
 *
 * The toggleable decision tool: given a task, asks TypeSafe Jev (System One)
 * which enabled agent type should execute it, under the routing rules. Every
 * failure path returns a visible result text — never a throw — so a dispatch
 * decision can never be blocked by the classifier (Jev is early-access; see
 * docs/jev.md). Registered only when `jevEnabled` is on (index.ts), and
 * excluded from subagents via SUBAGENT_TOOL_NAMES.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SUBAGENT_TOOL_NAMES } from "../lib/tool-names.js";
import { textResult } from "../ui/notifications.js";
import { askJev } from "./jev-client.js";
import { buildJevQuestion, buildJevState, buildRosterCriteria } from "./jev-state.js";

/**
 * The classifier key: `JEV_API_KEY` preferred, Vercel gateway key as the
 * transport the machine already proves (China-reachable, measured 214–444 ms).
 */
export function resolveJevKey(): string | undefined {
  return process.env.JEV_API_KEY?.trim() || process.env.VERCEL_AI_GATEWAY_API_KEY?.trim() || undefined;
}

function pct(value: number): string {
  return (value * 100).toFixed(0) + "%";
}

function renderDecision(res: {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | undefined;
  costUsd: number | null;
  ms: number;
  escalate: boolean;
  confMin?: number;
}): string {
  const top3 = Object.entries(res.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${pct(v)}`)
    .join(", ");
  const lines = [
    `winner: ${res.choice}`,
    `distribution (top 3): ${top3 || "none"}`,
    `confidence: ${res.confidence === undefined ? "n/a" : res.confidence.toFixed(2)}`,
  ];
  if (res.escalate) {
    lines.push(`escalate: winner confidence ${res.confidence?.toFixed(2) ?? "n/a"} is below conf_min ${res.confMin}`);
  }
  lines.push(`cost: $${res.costUsd?.toFixed(6) ?? "n/a"} · ${res.ms} ms`);
  return lines.join("\n");
}

export function createJevTool(_deps: unknown) {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.JEV,
    label: "Jev agent selector",
    description:
      "Ask TypeSafe Jev which agent type should execute a task. Sends the task, optional context, and the routing rules to a real-time decision model and returns the recommended agent type with its probability distribution and confidence. Fails open: on any error it returns a message; it never blocks a dispatch.",
    promptSnippet: "Consult Jev for the agent type to dispatch",
    parameters: Type.Object({
      task: Type.String({
        description: "The task to be dispatched — the text the orchestrator would send to the Agent tool.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional situation detail for Jev to weigh (repo state, constraints, urgency).",
        }),
      ),
      conf_min: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 1,
          description: "Confidence gate: when the winner's confidence is below this, the result flags escalate.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const key = resolveJevKey();
      if (!key) {
        return textResult(
          "jev unavailable: no classifier key — set JEV_API_KEY (or VERCEL_AI_GATEWAY_API_KEY) and retry; dispatch using your own judgment meanwhile.",
        );
      }
      const criteria = buildRosterCriteria();
      if (Object.keys(criteria).length === 0) {
        return textResult(
          "jev unavailable: roster has no describable agent types — no enabled agent type carries a description, so the choice question cannot be formed; dispatch using your own judgment.",
        );
      }
      const state = buildJevState(params.task, params.context);
      const res = await askJev(key, state, buildJevQuestion(criteria));
      if (!res.ok) {
        return textResult(`jev unavailable: ${res.error} — ${res.remedy}`);
      }
      const escalate =
        typeof params.conf_min === "number" && res.confidence !== undefined && res.confidence < params.conf_min;
      return textResult(
        renderDecision({
          choice: res.choice,
          probabilities: res.probabilities,
          confidence: res.confidence,
          costUsd: res.costUsd,
          ms: res.ms,
          escalate,
          confMin: params.conf_min,
        }),
      );
    },
  });
}