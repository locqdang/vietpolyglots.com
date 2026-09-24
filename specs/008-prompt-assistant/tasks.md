# Tasks: Image Prompt Assistant

**Input**: Design documents from `/specs/008-prompt-assistant/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: The feature's Verification Plan requires unit tests (the two pure security helpers + rate-limit), integration tests (the API handler), and E2E (Playwright). Test-first is declared for the two pure helpers and the 401/429 handler paths — those tests are written **first**, before the code they guard.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task belongs to (US1–US4)
- Exact file paths are included.

## Path Conventions (single-project web app, matches plan.md)

- Server lib: `src/lib/image-generate/`
- API route: `src/pages/api/image/prompt/`
- Client page: `src/app/image-generate/page.js`
- Unit tests: `src/tests/lib/`
- Integration tests: `src/tests/api/`
- E2E: `e2e/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the new modules' scaffolding and env surface. Nothing here changes existing behavior.

- [x] T001 [P] Add assistant env var names + defaults documentation and a small `getPromptAssistantConfig()` reader in `src/lib/image-generate/prompt-assistant-config.js` (reads `LLM_GATE_URL`, `PROMPT_ASSISTANT_MODEL`, `PROMPT_ASSISTANT_TIMEOUT_MS`, `PROMPT_ASSISTANT_RATE_LIMIT_MAX`, `PROMPT_ASSISTANT_RATE_LIMIT_WINDOW_SECONDS`, `PROMPT_ASSISTANT_MAX_IDEA`, `PROMPT_ASSISTANT_MAX_PROMPT` with safe defaults)
- [x] T002 [P] Document the new env vars in `.env.example` (names + defaults only; no secrets) so operators know what to set
- [x] T003 [P] Attach the `nextjs` service to the `gpu-gate_default` external network in `docker-compose.yml` (declare `gpu-gate_default` as external, add to `nextjs-app.networks`) so `http://gpu-gate:8081` resolves (see plan R1)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core, reusable pieces that every user story depends on. **No user story work begins until this phase is complete.**

- [x] T004 [P] Implement the **prompt-injection-safe request builder** `buildPromptAssistantRequest(idea)` in `src/lib/image-generate/prompt-assistant-request.js`: a **fixed** system instruction constant + the idea placed **only** in the `user` message; returns `{ ok, request, error }`; rejects non-string / empty / oversized idea (uses config from T001)
- [x] T005 [P] Implement the **strict response validator** `parsePromptAssistantResponse(rawContent)` in `src/lib/image-generate/prompt-assistant-response.js`: tolerate a single surrounding-quote wrapper + locate `{…}`; `JSON.parse`; enforce **exactly** string `prompt` (non-empty) + string `negative_prompt`, **no extra keys**, each ≤ max; returns `{ ok, prompt, negativePrompt, error }` (see research R3)
- [x] T006 [P] Implement the **server-side LLM gate client** `generatePromptPair(idea)` in `src/lib/image-generate/prompt-assistant-gate.js`: `POST {LLM_GATE_URL}/v1/chat/completions` with the request from T004, `AbortController` timeout bound (default 90s); maps network error → `502`, timeout → `504`; returns `choices[0].message.content` (raw string) — mirrors `gate-client.js`'s `fetchWithTimeout`/`GateError` pattern
- [x] T007 [P] Implement the **assistant rate limiter** in `src/lib/image-generate/prompt-assistant-rate-limit.js`: Redis key `prompt-assistant:rate:<sha256(email)>`, atomic `INCR`+`PEXPIRE`+`PTTL` Lua, `getPromptAssistantRateLimitConfig()`, `checkPromptAssistantRateLimit(email)`, fail-closed on Redis error — mirrors `rate-limit.js`
- [x] T008 Verify baseline test tooling runs green (existing `npm run test:unit` and `npm run lint`) before adding new tests

**Checkpoint**: Foundation ready — the four reusable modules exist and existing tests still pass. User story implementation can now begin.

---

## Phase 3: User Story 1 — A signed-in user turns a short idea into a refined prompt (Priority: P1) 🎯 MVP

**Goal**: The whole point of the feature — a short idea becomes a refined positive + negative prompt that pre-fills the form.

**Independent Test**: Sign in, open `/image-generate`, type a short idea, click **Help generate prompt**, and confirm the main prompt + negative fields are populated (model client can be stubbed for automated tests; live model for smoke).

### Tests for User Story 1

> Test-first: write these failing tests **before** the implementation they guard.

- [x] T009 [P] [US1] **Failing unit test** for `buildPromptAssistantRequest` in `src/tests/lib/prompt-assistant-request.test.js`: prove the idea lands **only** in the `user` message and never in the system text; empty/whitespace/oversized ideas are rejected; a valid idea yields a well-formed chat request with `response_format: json_object`
- [x] T010 [P] [US1] **Failing unit test** for `parsePromptAssistantResponse` in `src/tests/lib/prompt-assistant-response.test.js`: accept a valid object and the **quoted-wrapper** form; reject non-JSON, missing/wrong-type fields, **extra keys**, empty `prompt`, over-limit fields; injection- and markup-laden inputs yield either a valid text-only pair or an error (never raw pass-through)
- [x] T011 [P] [US1] **Failing unit test** for the assistant rate-limit config/key/counter in `src/tests/lib/prompt-assistant-rate-limit.test.js` (env-driven limits, distinct key prefix, fail-closed behavior)
- [x] T012 [US1] **Failing integration test** for the API handler in `src/tests/api/prompt-assistant.integration.test.js`: `200` with a valid pair when a valid session + conforming (stubbed) model response; `400` for empty/oversized idea (no model call); `502`/`504` when the stubbed gate client fails/times out; model host/port never in the response (mock `readSession`, rate-limit, and gate client)
- [x] T013 [US1] Implement the **API route** `POST /api/image/prompt/assistant` in `src/pages/api/image/prompt/assistant.js`: method check → `readSession` (401) → validate idea (400) → rate limit (429/503) → `generatePromptPair` (502/504) → `parsePromptAssistantResponse` (422) → `200 { prompt, negativePrompt }`; `createApiLogger` + pino (hashed user id, no raw email/idea/output); `no-store` headers (depends on T004–T007)
- [x] T014 [US1] Add the **assistant UI** to `src/app/image-generate/page.js`: an assistant field (short idea) + **Help generate prompt** button; on success set `prompt` and `negative` from the response; loading/pending state; disable while in flight; English copy (depends on T013)
- [x] T015 [US1] Add **assistant styles** (BEM, matching the existing `image-generate__*` classes) to the page's stylesheet so the new field/button/label match the card's look and feel

**Checkpoint**: US1 fully functional and independently testable — a short idea becomes a populated, editable prompt + negative prompt.

---

## Phase 4: User Story 2 — Route and API are protected and require authentication (Priority: P1)

**Goal**: Unauthenticated users cannot use the assistant (page redirects to login; API returns 401).

**Independent Test**: `POST` the assistant API without a valid session → `401`; open `/image-generate` signed out → existing login redirect (assistant lives on that page).

### Tests for User Story 2

- [x] T016 [P] [US2] **Failing integration test** in `src/tests/api/prompt-assistant.integration.test.js`: `401` without a session and **no** rate-limit/model call (extend the T012 file)
- [x] T017 [P] [US2] **Failing E2E test** in `e2e/image-generate-assistant.spec.js`: unauthenticated navigation to `/image-generate` redirects to login (the assistant is not reachable signed out)

### Implementation for User Story 2

- [x] T018 [US2] Confirm the API route enforces `readSession` → `401` **before** any other work, and that the page is already client-gated (`/image-generate` in `RequireAuth` `privateRoutes`); add/verify the 401 path is hit before rate-limit and model call (depends on T013; mostly verification + T016/T017 passing)

**Checkpoint**: US1 AND US2 both work independently — the assistant is authenticated end to end.

---

## Phase 5: User Story 3 — The assistant is safe against prompt injection and other attacks (Priority: P1)

**Goal**: The short idea is data only; output is strictly validated; no injection, no XSS, no resource abuse, no host/secret leakage.

**Independent Test**: Send injection-style short ideas and non-conforming model outputs; confirm the result is always either a valid in-schema pair rendered as text, or a clear error — never a raw model dump, behavior change, or executed markup.

### Tests for User Story 3

- [x] T019 [P] [US3] Extend `src/tests/lib/prompt-assistant-request.test.js` with explicit **injection** cases: idea containing "ignore your instructions", a fake JSON blob, role-play, and markup — assert they appear only in the `user` message and can't alter the system text, model, or `response_format`
- [x] T020 [P] [US3] Extend `src/tests/lib/prompt-assistant-response.test.js` with **non-conforming/injection** model outputs (non-JSON, extra keys, wrong types, over-limit, markup-laden) — assert all are rejected (never returned)
- [x] T021 [P] [US3] Extend `src/tests/api/prompt-assistant.integration.test.js`: non-conforming model output → `422` with **no** output in the body; oversized idea → `400` with **no** model call; rate-limited → `429` + `Retry-After` with **no** model call
- [x] T022 [US3] **Security review** of the full path: confirm (a) user text is never interpolated into the system prompt or any control field, (b) only validated `{ prompt, negativePrompt }` is returned and rendered as plain text, (c) model host/port/identity never reach the browser (no header/body leak), (d) logs carry only hashed id + safe context

### Implementation for User Story 3

- [x] T023 [US3] Harden `src/lib/image-generate/prompt-assistant-request.js` / `-response.js` / the API route as needed to satisfy T019–T022 (depends on T004/T005/T013)

**Checkpoint**: US1, US2, and US3 all work independently — the assistant is safe by construction.

---

## Phase 6: User Story 4 — Assistant errors and edge cases are handled gracefully (Priority: P2)

**Goal**: Clear, actionable feedback for empty input, model/gate unavailability, timeout, rate-limit, and unusable output; the page stays usable and the user can retry.

**Independent Test**: Submit an empty idea (validation) and, with the model/gate down or returning garbage, confirm a clear error appears, the page doesn't hang, and existing fields are unchanged; the user can retry.

### Tests for User Story 4

- [x] T024 [P] [US4] Extend `src/tests/api/prompt-assistant.integration.test.js`: rate limiter unavailable → `503`; timeout → `504`; empty idea → `400`; each leaves no partial/invalid output
- [x] T025 [P] [US4] Extend `e2e/image-generate-assistant.spec.js`: empty idea shows a validation message and sends nothing; a failing assistant call shows an error, leaves the existing prompt/negative fields unchanged, and the control re-enables for retry

### Implementation for User Story 4

- [x] T026 [US4] Wire client-side handling in `src/app/image-generate/page.js`: client-side empty/length validation before submit; on API error show a clear message, leave `prompt`/`negative` unchanged, reset the loading state so the user can retry (depends on T014)
- [x] T027 [US4] Ensure the API route returns distinct, user-facing error messages for each failure class (validation / rate-limited / unavailable / timeout / unusable output) consistent with `contracts/api.md`

**Checkpoint**: All four user stories are independently functional and robust.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-cutting validation, cleanup, and the live-model smoke.

- [x] T028 [P] Add/extend the **E2E authenticated flow** in `e2e/image-generate-assistant.spec.js`: authenticated user types a short idea, clicks **Help generate prompt** (assistant call stubbed in E2E), fields populate, the user edits and the Generate flow is reachable
- [x] T029 Run `npm run lint` and `npm run build` and fix any issues introduced by this feature
- [x] T030 Run the full automated suite (`npm run test:unit`, `npm run test:integration`, `npm run test:e2e`) and confirm green
- [x] T031 Run the **manual live-model smoke** from `quickstart.md` (real `http://gpu-gate:8081` + model): a sensible refined prompt + non-empty negative prompt populate the fields; injection idea doesn't change behavior; model host/port never leaks; rate limit returns `429`. Record outcomes.
- [x] T032 [P] Documentation: note the new env vars and the private-network requirement in the feature's `quickstart.md`/deployment notes (already drafted; verify accuracy)
- [x] T033 Code cleanup: remove dead code, consistent naming/comments in the new modules, verify no secret/host appears in client bundle or responses

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — **blocks all user stories**.
- **User Stories (Phases 3–6)**: All depend on Foundational. US1 first (MVP); US2/US3 reinforce US1; US4 is P2 polish of error handling. They can proceed in priority order; US2–US4 build on US1's route.
- **Polish (Phase 7)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational — the MVP; provides the route the other stories extend.
- **US2 (P1)**: Builds on US1's route (auth gate) — verify/strengthen 401 + client redirect.
- **US3 (P1)**: Builds on US1's helpers + route — the security hardening; largely test-driven.
- **US4 (P2)**: Builds on US1's route + UI — error/edge handling.

### Within Each User Story

- Failing tests first (where declared) → implementation → integration → (E2E after the page exists).
- Helpers (request/response/gate/rate-limit) before the route; route before the UI.

### Parallel Opportunities

- Setup T001/T002/T003 are independent [P].
- Foundational T004/T005/T006/T007 are independent modules [P] (all depend only on T001 config).
- Per-story test tasks marked [P] can run in parallel; US2/US3 test extensions are in different test files.

---

## Parallel Example: Foundational + US1

```text
# Foundation (independent modules, run together once config exists):
Task: T004 request builder   (prompt-assistant-request.js)
Task: T005 response validator (prompt-assistant-response.js)
Task: T006 gate client        (prompt-assistant-gate.js)
Task: T007 rate limiter       (prompt-assistant-rate-limit.js)

# Then US1 tests in parallel, then the route, then the UI:
Task: T009 request builder tests
Task: T010 response validator tests
Task: T011 rate-limit tests
Task: T012 handler integration tests
  -> T013 API route
  -> T014 assistant UI
  -> T015 assistant styles
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational — blocks all stories).
2. Complete Phase 3 (US1) — the short-idea → prompt + negative flow.
3. **STOP and VALIDATE**: run US1 unit + integration tests (model stubbed) and a manual live-model smoke.
4. This is the deployable MVP.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → verify independently → (MVP).
3. US2 → verify auth independently.
4. US3 → verify security independently.
5. US4 → verify error handling.
6. Polish (Phase 7): full suite + live smoke + cleanup.

### Security-first note

US3 (prompt-injection safety) is **P1**, not deferrable polish — the two pure helpers (T004/T005) are written test-first and the route only returns validated output from the start, so security is present from the MVP, not added afterwards.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] labels map each task to a spec user story for traceability.
- Do not omit required verification just because implementation feels small.
- **Pause before any commit/deploy** — per the user's build flow (Spec Kit → code → lint/build → E2E → pause before commit/deploy). This task list stops at a validated, uncommitted state.
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence.
