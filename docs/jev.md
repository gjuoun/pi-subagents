# Jev agent selector — decision semantics

**Audience:** extension users (and the orchestrator model) who enable `/agents → Settings → Jev agent selector` and want to know what the `jev` tool does under the hood, how to read its output, and how to tune it. The tool is a dispatch decision aid, not a routing authority.

## What it is

`jev` asks **TypeSafe Jev** (a System One decision model — sub-second, typed answers, no text generation) which enabled agent type should execute a task. A `choice` question is sent over the Vercel AI Gateway evaluation endpoint; the answer is the winner plus a calibrated probability distribution and a confidence value. The tool is registered only when the setting is on, is excluded from subagents, and **fails open**: every error path returns a visible `jev unavailable: …` message with a remedy — it can never block or throw for a dispatch.

## State composition

The state sent to the model is assembled from three parts:

1. **TASK** — the untmodified `task` parameter (the text the orchestrator would send to the Agent tool).
2. **CURRENT SITUATION** — the optional `context` parameter, or a fixed default paragraph.
3. **ROUTING RULES** — the ruleset injected into the state: `JEV_ROUTING_RULES` env path if set, else shadow's `agent-routing.md` (the routing rules the orchestrator already applies by hand) if readable, else omitted. The tool ships generic; routing knowledge is configuration.

The `choice` criteria are the enabled agent types mapped to their descriptions (empty descriptions are dropped). One atomic question only — Jev 1.13 is literal-minded: no counting, no multi-hop, and contradictions between instructions and criteria hurt, so keep the state honest and the question single.

## Reading the output

```
winner: finder
distribution (top 3): finder 96%, expert 2%, prospector 2%
confidence: 0.95
cost: $0.000088 · 310 ms
```

- `winner` — the recommended agent type; always one of the currently enabled, describable types.
- `distribution (top 3)` — calibrated probabilities over the roster.
- `confidence` — the model's confidence in the answer (0..1).
- `escalate` — present only when `conf_min` was given and the winner's confidence is below it: the signal to confirm with the user or escalate to a stronger process rather than dispatching on autopilot.
- `cost` / `ms` — billed input cost and latency, so a user learns what decisions cost.

## Tuning

- **`conf_min`** — confidence-gated routing: set it when a wrong agent choice is worse than a slow confirm. Split distributions (e.g. implement vs investigate-first) show up as low confidence; that is the escalation signal.
- **Latency and cost** are small (hundreds of ms, ~$0.0001/decision at ~2k input tokens) but nonzero, which is why the feature is **off by default**.

## Transport

Defaults to the **Vercel AI Gateway** (`JEV_BASE_URL`, `VERCEL_AI_GATEWAY_API_KEY` fallback key) — the transport this project measured live on the user's machine (214–444 ms, see the probe empirics below). The base URL, model id, and key are all env-overridable, so switching transports (OpenRouter's `typesafe/jev-1.13`, or direct `api.typesafe.ai` once reachable) is a configuration change, not a code change. Jev is closed-weight, US-hosted, early-access; the fail-open contract exists because the vendor's uptime is not something a dispatch pipeline should depend on.

## Measured behaviour (2026-09-18, live gateway)

State = task + situation + `agent-routing.md`, criteria = name → description, 4 tasks:

| Task | Winner | Conf | Note |
|---|---|---|---|
| Implement a JSON schema validator in TS with tests | worker 0.68 | 0.64 | implementation → worker
| Find why this flaky test fails and fix it | finder 0.63 | 0.59 | investigate-first per the routing rules
| 把 av-actress-dataset 的筛选页面加上标签过滤 (zh) | worker 0.48 / finder 0.41 | 0.43 | genuinely split — implement vs investigate-first; low confidence is the signal
| 看看这个项目怎么回事 (zh) | finder 0.96 | 0.95 | ambiguous investigation → finder, high certainty

~2,087 input tokens/decision, 214–444 ms, ~$0.000088/decision (custom-only roster). Chinese tasks classify fine but at lower confidence (Jev is English-first) — exactly what `conf_min` escalation is for.

With the **full shipped registry** (defaults `general-purpose`/`Explore`/`Plan` included in the criteria), the same tasks still settle on the right class but confidence drops and splits widen — `Find why this flaky test fails and fix it` → finder at 0.34, conf 0.28 (general-purpose 0.27 close behind), and the Chinese filter task → worker 0.51 / finder 0.22, conf 0.46. That is the honest cost of presenting a generic option: `conf_min` + human confirm is the intended response, not a raised threshold that tunes out real uncertainty.