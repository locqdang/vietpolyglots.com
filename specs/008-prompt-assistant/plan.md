# Implementation Plan: Image Prompt Assistant

**Branch**: `008-prompt-assistant` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-prompt-assistant/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Add a "prompt assistant" to the existing `/image-generate` page (feature `007-image-generate`). A signed-in user enters a short idea, clicks **Help generate prompt**, and a server-side API calls the **Qwen uncensored model** (`Qwen3.8-27B-Uncensored-MTP-Q5_K_P`) through the GPU gate's **OpenAI-compatible chat endpoint** to produce a refined **positive prompt** and a **negative prompt**. Those values populate the existing "Describe your image" and "Things to avoid" fields, which the user reviews/edits before generating.

The feature reuses the `007-image-generate` conventions end-to-end: `readSession` auth, Redis-backed per-user rate limiting, a pure request/output mapping module, a server-side gate client with a timeout bound, `createApiLogger`/pino structured logging, BEM CSS in the client page, and vitest unit + handler integration tests. It is deliberately **synchronous** (no new queue/worker) and **non-persistent**.

Security is a first-class requirement: the user's short idea is treated strictly as **data** (fixed, server-controlled instruction set; the model, destination, and behavior cannot be influenced by user text), the model's output is **strictly schema-validated** (exactly `prompt` + `negativePrompt`, bounded strings) and rendered only as **plain text**, the API is **auth-gated** (`401`), **rate-limited** (`429` + `Retry-After`), **timeout-bounded** (`504`), and the model's host/port/identity are **never exposed** to the browser.

## Technical Context

**Language/Version**: Node.js 22+ (existing Next.js 16 app; no version change). JavaScript (the app's existing style — no TypeScript for new feature files, matching `src/lib/image-generate/*` and the `page.js`).

**Primary Dependencies**: **No new runtime dependencies.** Reuse `ioredis` (rate limiting), `next`/`react` (page + API route), `pino` (logging via `src/lib/logger.js`). The model is reached with the global `fetch` (same as `gate-client.js`). No `openai`/SDK package is added — the OpenAI-compatible endpoint is a plain `POST` with JSON.

**Storage**: **None new.** Redis is reused only for the assistant's per-user rate-limit counter (a separate key/DB-1 counter from image generation). No MongoDB job record, no persistence of the generated prompts (the existing image-generation history persists the _final_ prompt the user actually generates with).

**Testing**: **Vitest** for unit (pure helpers) and integration (API handler with mocked deps) — matches `src/tests/lib/*` and `src/tests/api/*`. **Playwright** for E2E (config exists at `playwright.config.js`, `testDir: ./e2e`, dev server on `127.0.0.1:3100`); the assistant's full browser flow is E2E + a manual live-model smoke (the model/gate is a real, slow, external dependency and is stubbed in automated tests).

**Target Platform**: Linux server, Dockerized (`nextjs` container, port `3004:3000`), behind the site's existing nginx.

**Project Type**: Web application (Next.js App Router client page + Pages-Router API routes), extending an existing feature.

**Performance Goals**: A single assistant call is one model chat completion (a 27B model; expect seconds to ~1–2 minutes on first load). The page shows a loading state for the duration. The request is **timeout-bounded** (default `90s`, env-overridable) so the UI never hangs. Because the gate **serializes GPU access** (a single GPU lease), an in-flight assistant call and an in-flight image generation do not run concurrently.

**Constraints**:

- The model/gate endpoint is **server-only**. The browser never reaches it directly and never learns its host/port (FR-013).
- The LLM gate is currently bound to the GPU host's **loopback** (`127.0.0.1:8081`); the `nextjs` container is on a different Docker network and cannot reach it as-is. Reachability is resolved by a **private, shared internal Docker network** (see Research R1) so the backend calls the gate by service name while it stays off the public internet and the LAN.
- The user's short idea must be bounded (input length) and the generated output must be bounded (each field) (FR-004, FR-009).
- Assistant rate limit must be **independent and tighter** than the image-generation limit (FR-015).
- No new secret/credential is introduced; the model is reached over the existing trust boundary (internal network). If the gate requires an API key, it is supplied server-side via env and never exposed.

**Scale/Scope**: One added page section + one new API route + a small set of pure lib modules + tests. Single feature, no new services, no migrations.

## Verification Strategy

**Lead Test Decision**:

- **Unit**: The two pure helpers that are the core of the security defense:
  - `buildPromptAssistantRequest` (fixed instruction set + user idea → the structured chat request). Must prove the user idea lands **only in the data position**, never in the system/instruction text; rejects empty/oversized ideas.
  - `parsePromptAssistantResponse` (raw model response → validated `{ prompt, negativePrompt }` **or** an error). Must accept only conforming output and reject non-JSON, missing/wrong-typed fields, unexpected extra fields, and over-limit fields; injection- and markup-laden inputs yield either a valid text-only result or an error — never a raw pass-through.
- **Integration**: The API handler (mocked session/rate-limit/model client): `401` without session, `400` for empty/oversized idea, `429` + `Retry-After` when over limit, `200` with a valid pair when session + conforming (stubbed) response, and a `4xx`/`5xx` (no rendered output) when the stubbed model returns non-conforming or injection-style output. Model host/port must never appear in any response body.
- **E2E** (Playwright): Unauthenticated navigation to `/image-generate` redirects to login (the assistant lives on that page). An authenticated user types a short idea, clicks **Help generate prompt**, and the main prompt + negative fields are populated; the user can edit and the Generate flow is reachable. (The assistant's network call is stubbed in the E2E environment so the flow is deterministic without a live GPU; the live-model path is covered by the manual smoke below.)
- **Manual Smoke**: With the gate/model reachable, run a real request from the browser (e.g. "a red fox in the snow") and confirm a sensible refined prompt + non-empty negative prompt populate the fields; confirm an injection-style idea does not change behavior or surface raw model text; confirm the model host/port never appears in page HTML, network responses, or client code.

**Test-First Targets**:

1. `buildPromptAssistantRequest` — stable, pure, cheap; it _is_ the prompt-injection defense. Start with failing unit tests (data-position isolation, empty/oversized rejection).
2. `parsePromptAssistantResponse` — the second security line; pure logic. Start with failing unit tests including explicit injection / non-conforming / markup cases.
3. API auth gate (`401`) and rate-limit (`429`) handler paths — clear, stable permission rules; start with failing integration tests.
4. E2E full browser flow — verified after implementation (depends on the rendered page + a stubbed assistant call).

## Constitution Check

_Gate: Must pass before Phase 0 research. Re-check after Phase 1 design._

- **Spec or ticket exists and scope is explicit.** ✅ `spec.md` exists (19 FRs, 8 SCs, 0 open clarifications); scope bounded to one page section + one API route + pure lib modules + tests.
- **Verification strategy is defined by Lead before implementation.** ✅ Lead decision above (unit-first on the two security helpers, handler integration, Playwright E2E, manual live-model smoke).
- **Test-first targets are identified when behavior is clear enough.** ✅ The two pure security helpers and the 401/429 handler paths (see Test-First Targets).
- **User-facing flows needing browser or E2E proof are identified.** ✅ Unauth redirect + assistant populates-fields + edit/generate reachability.
- **Observability, review pause, and deploy smoke requirements are captured.** ✅ Structured logging via `createApiLogger`/pino (hashed user id, no raw email, redacted secrets); review pause before commit/deploy per the user's build flow; deploy smoke = manual live-model request + confirming the gate/model host/port never leak.

**Result: PASS.** No gate violations, so no Complexity Tracking entry is required (section left empty).

## Project Structure

### Documentation (this feature)

```text
specs/008-prompt-assistant/
├── spec.md              # Feature specification (done)
├── checklists/
│   └── requirements.md  # Quality checklist (done)
├── plan.md              # This file
├── research.md          # Phase 0 (assumptions resolved)
├── data-model.md        # Phase 1 (entities + validation)
├── quickstart.md        # Phase 1 (run/validation guide)
└── contracts/
    └── api.md           # Phase 1 (POST /api/image/prompt/assistant contract)
```

### Source Code (repository root)

```text
src/
├── lib/
│   └── image-generate/
│       ├── prompt-assistant-request.js   # NEW — pure: fixed instruction set + idea → chat request
│       ├── prompt-assistant-response.js  # NEW — pure: raw model output → validated { prompt, negativePrompt } | error
│       ├── prompt-assistant-gate.js      # NEW — server-side OpenAI-compat client (timeout, JSON output)
│       └── prompt-assistant-rate-limit.js# NEW — Redis per-user assistant limiter (separate key/config)
├── pages/
│   └── api/
│       └── image/
│           └── prompt/
│               └── assistant.js          # NEW — POST route (auth → validate → rate-limit → model → 200/4xx/5xx)
├── app/
│   └── image-generate/
│       └── page.js                       # EXTEND — add assistant field + "Help generate prompt" + state
└── tests/
    ├── lib/
    │   ├── prompt-assistant-request.test.js    # NEW — unit (data-position isolation, validation)
    │   ├── prompt-assistant-response.test.js   # NEW — unit (schema validation, injection/markup)
    │   └── prompt-assistant-rate-limit.test.js # NEW — unit (config, key, counter behavior)
    └── api/
        └── prompt-assistant.integration.test.js# NEW — handler (401/400/429/200/invalid-model-output)
e2e/
    └── image-generate-assistant.spec.js        # NEW — Playwright (redirect, populate, edit)
docker-compose.yml                              # EXTEND — attach nextjs to the private gate network
.env                                            # EXTEND — LLM_GATE_URL, model id, limits, timeout (names only here; values in the secret store)
```

**Structure Decision**: Single-project web app, **extending the existing `007-image-generate` module tree** rather than creating a parallel one. The assistant is a sub-feature of image generation, so it lives under `src/lib/image-generate/` and `src/pages/api/image/` and extends the same client page. This keeps the auth, logging, rate-limit, and gate-client patterns physically adjacent to the code they mirror, and matches how `007` is organized. No new service, no new queue/worker (synchronous design), no new directory beyond the natural `prompt/assistant.js` route and `e2e/`.

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
