/**
 * jev-client.test.ts — request shape, response parse, fail-open paths.
 *
 * The client never throws: every failure returns `{ok:false, error, remedy}`
 * so a dispatch decision can never be blocked by the classifier (Jev is days
 * old and early-access — see docs/jev.md). fetchImpl is injectable; the suite
 * stays offline on the fixture.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askJev, buildJevRequest, type FetchLike, type JevQuestions } from "../src/tools/jev-client.js";

const KEY = "sk-test";
const STATE = "TASK: build a parser";
const QUESTIONS: JevQuestions = {
  agent: { type: "choice", instructions: "Which agent type should execute this task?", criteria: { worker: "implements", finder: "searches" } },
};

function okResponse(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}
function failResponse(status: number, body: unknown): FetchLike {
  return async () => ({ ok: false, status, text: async () => JSON.stringify(body) });
}

describe("buildJevRequest", () => {
  it("carries the three mandatory gateway headers, the model in ai-model-id, and the body {state, questions}", () => {
    const { url, init } = buildJevRequest(KEY, STATE, QUESTIONS);
    expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["ai-gateway-protocol-version"]).toBe("0.0.1");
    expect(headers["ai-evaluation-model-specification-version"]).toBe("4");
    expect(headers["ai-model-id"]).toBe("typesafe-ai/jev");
    expect(JSON.parse(init.body as string)).toEqual({ state: STATE, questions: QUESTIONS });
  });
});

describe("askJev", () => {
  it("parses a valid response into ok:true with choice/probabilities/confidence/usage/cost", async () => {
    const body = JSON.parse(readFileSync("test/fixtures/jeval-response.sample.json", "utf8"));
    const res = await askJev(KEY, STATE, QUESTIONS, okResponse(body));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.choice).toBe("worker");
      expect(res.probabilities.worker).toBeCloseTo(0.68, 5);
      expect(res.confidence).toBeCloseTo(0.64, 5);
      expect(res.inputTokens).toBe(2087);
      expect(res.costUsd).toBeCloseTo(2087 * 0.042 / 1e6, 8);
    }
  });

  it("maps an HTTP 500 to ok:false with a remedy", async () => {
    const res = await askJev(KEY, STATE, QUESTIONS, failResponse(500, { error_type: "server_error" }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("500") });
  });

  it("names the state limit when the state exceeds it (max_tokens_exceeded)", async () => {
    const res = await askJev(KEY, STATE, QUESTIONS, failResponse(400, { error_type: "max_tokens_exceeded" }));
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.remedy).toMatch(/32k|state|smaller/i);
  });

  it("fails open on a network throw — never throws out of the client", async () => {
    const res = await askJev(KEY, STATE, QUESTIONS, async () => { throw new Error("ECONNRESET"); });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("network") });
  });

  it("rejects a malformed body (non-choice answer) as ok:false, not a crash", async () => {
    const res = await askJev(KEY, STATE, QUESTIONS, okResponse({ answers: { agent: { type: "score", score: 2 } } }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("Malformed") });
  });

  it("rejects non-JSON bodies", async () => {
    const res = await askJev(KEY, STATE, QUESTIONS, async () => ({ ok: true, status: 200, text: async () => "<html>oops" }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("JSON") });
  });
});
