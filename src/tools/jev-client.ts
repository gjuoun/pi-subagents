/**
 * jev-client.ts — the `jev` tool's HTTP client: request, parse, fail-open.
 *
 * Pure module, no pi imports, `fetchImpl` injectable for tests. Speaks the
 * evaluation endpoint the way vgw proved on this machine (2026-09-18): the
 * model id rides in the `ai-model-id` HEADER (the body has no model field),
 * `ai-gateway-protocol-version: 0.0.1` is mandatory (omitting it is a 400),
 * and answers come back as typed distributions, not prose. Every failure path
 * returns a discriminated `JevResult` with a remedy string — never a throw —
 * so a dispatch decision can never be blocked by the classifier.
 */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const JEV_MODEL_DEFAULT = "typesafe-ai/jev";
/** USD per 1M input tokens for `typesafe-ai/jev`; output tokens are free. */
export const JEV_INPUT_PRICE_PER_M = 0.042;

export type JevQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevQuestions = Record<string, JevQuestion>;

export type JevOk = {
  ok: true;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | undefined;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  ms: number;
};
export type JevErr = { ok: false; error: string; remedy: string };
export type JevResult = JevOk | JevErr;

/** Structural fetch: injectable so the suite stays offline. */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text">>;

function baseUrl(): string {
  return (process.env.JEV_BASE_URL ?? "https://ai-gateway.vercel.sh/v4/ai").replace(/\/+$/, "");
}
function modelId(): string {
  return process.env.JEV_MODEL_ID ?? JEV_MODEL_DEFAULT;
}
function timeoutMs(): number {
  const n = Number(process.env.JEV_TIMEOUT_MS ?? 5000);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/** Exported so the header contract can be asserted without touching the network. */
export function buildJevRequest(
  key: string,
  state: unknown,
  questions: JevQuestions,
): { url: string; init: RequestInit } {
  return {
    url: `${baseUrl()}/evaluation-model`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": modelId(),
      },
      body: JSON.stringify({ state, questions }),
    },
  };
}

const jevResponseSchema = Type.Object({
  answers: Type.Record(
    Type.String(),
    Type.Object({
      type: Type.Literal("choice"),
      choice: Type.String(),
      probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
    }),
  ),
  providerMetadata: Type.Optional(
    Type.Object({
      typesafe: Type.Optional(
        Type.Object({
          confidence: Type.Optional(Type.Record(Type.String(), Type.Number())),
        }),
      ),
    }),
  ),
  usage: Type.Optional(
    Type.Object({
      inputTokens: Type.Optional(Type.Number()),
      outputTokens: Type.Optional(Type.Number()),
    }),
  ),
});

type ParsedJevResponse = {
  answers: Record<string, { type: "choice"; choice: string; probabilities?: Record<string, number> }>;
  providerMetadata?: { typesafe?: { confidence?: Record<string, number> } };
  usage?: { inputTokens?: number; outputTokens?: number };
};

function malformed(detail: string): JevErr {
  return { ok: false, error: `Malformed response: ${detail}`, remedy: "the classifier's answer did not match the expected contract; dispatch using your own judgment" };
}

function errorTypeOf(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error_type" in body) {
    const v = (body as Record<string, unknown>).error_type;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

export async function askJev(
  key: string,
  state: unknown,
  questions: JevQuestions,
  fetchImpl: FetchLike = fetch,
): Promise<JevResult> {
  const t0 = Date.now();
  const { url, init } = buildJevRequest(key, state, questions);
  const requestInit = { ...init, signal: AbortSignal.timeout(timeoutMs()) };

  let response: Pick<Response, "ok" | "status" | "text">;
  try {
    response = await fetchImpl(url, requestInit);
  } catch {
    return {
      ok: false,
      error: "network failure calling the classifier",
      remedy: "the classifier could not be reached; dispatch using your own judgment and retry later",
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return malformed("the response was not JSON");
  }

  if (!response.ok) {
    const etype = errorTypeOf(body);
    if (etype === "max_tokens_exceeded") {
      return {
        ok: false,
        error: "max_tokens_exceeded",
        remedy: "the injected state is too large for the classifier's 32k limit — pass a smaller task/context and retry",
      };
    }
    return {
      ok: false,
      error: `classifier HTTP ${response.status}${etype ? ` (${etype})` : ""}`,
      remedy: "the classifier request failed; dispatch using your own judgment and retry later",
    };
  }

  let parsed: ParsedJevResponse;
  try {
    parsed = Value.Parse(jevResponseSchema, body) as ParsedJevResponse;
  } catch {
    return malformed("the answer schema did not match");
  }

  const answer = parsed.answers.agent;
  if (!answer || answer.type !== "choice") return malformed("no choice answer for 'agent'");
  const confidence = parsed.providerMetadata?.typesafe?.confidence?.agent;
  const inputTokens = parsed.usage?.inputTokens ?? null;
  const outputTokens = parsed.usage?.outputTokens ?? null;
  return {
    ok: true,
    choice: answer.choice,
    probabilities: answer.probabilities ?? {},
    confidence,
    inputTokens,
    outputTokens,
    costUsd: inputTokens === null ? null : (inputTokens * JEV_INPUT_PRICE_PER_M) / 1e6,
    ms: Date.now() - t0,
  };
}
