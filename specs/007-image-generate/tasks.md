# Tasks: Image Generate Service

**Input**: Design documents from `/specs/007-image-generate/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Unit (payload mapping + validation), integration (API auth/validation/contract), E2E (redirect + generate + nav), manual smoke (live gate).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Copy language**: English (FR-014, user-confirmed; overrides Constitution V default).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Single Next.js project. Source at `src/`, unit + integration tests under `src/tests/`, E2E under `e2e/`.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm tooling required by the Verification Plan is present.

- [ ] T001 Confirm vitest + `@playwright/test` tooling and `test:unit` / `test:integration` / `test:e2e` scripts in `package.json` (no new packages expected)
- [ ] T002 Confirm the E2E auth helper `e2e/helpers/route-auth.js` (`signInWithMagicLink`) is importable and the test login-link endpoint exists

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core configuration that MUST be complete before any user story.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 Add `GPU_GATE_URL` to `.env.example` (default `http://192.168.0.62:8189`) and to `.env` (real value, same default) — FR-012. Document that the gate is LAN-bound on `192.168.0.62` (loopback will not work).
- [ ] T004 [P] Create the server-only module directory and a `GPU_GATE_URL` accessor in `src/lib/image-generate/env.js` (reads `process.env.GPU_GATE_URL`, falls back to `http://192.168.0.62:8189`)

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 - Generate an image from a text description (Priority: P1) 🎯 MVP

**Goal**: A signed-in user enters a prompt on the Image Generate page and sees the generated image. Covers FR-001, FR-003, FR-004 (server), FR-006, FR-007, FR-008, FR-011, FR-013, FR-014.

**Independent Test**: Sign in, open `/services/image-generate`, enter a prompt, submit, and confirm a generated image is displayed (gate reachable) or a terminal state is reached.

### Tests for User Story 1

> Write the failing tests first (test-first is declared for the payload helper and the `401` gate).

- [ ] T005 [P] [US1] Unit test for `buildChromaPayload` (valid payload from prompt; passes optional params only when provided; rejects empty/whitespace/oversized prompt) in `src/tests/lib/image-generate-payload.test.js`
- [ ] T006 [P] [US1] Integration test for `POST /api/image/generate` happy path with a stubbed gate (session present + valid prompt → `200` with `image` data URL, `promptId`, `seed`; gate called once) in `src/tests/api/image-generate.integration.test.js`

### Implementation for User Story 1

- [ ] T007 [P] [US1] Implement `buildChromaPayload(request)` (pure: trim prompt, validate non-empty + max length, pass through optional `negative_prompt`/`width`/`height`/`steps`/`cfg`/`seed`) in `src/lib/image-generate/payload.js` (depends on T005)
- [ ] T008 [P] [US1] Implement the server-only gate client in `src/lib/image-generate/gate-client.js`: `generateImage(payload)` → `POST {GPU_GATE_URL}/api/chroma/generate` (bounded timeout), then fetch the first image's relative `url` against the base URL and return `{ dataUrl, promptId, seed }` (depends on T004)
- [ ] T009 [US1] Implement the API route `POST /api/image/generate` in `src/pages/api/image/generate.js`: guard with `readSession` (401 if absent), validate payload via `buildChromaPayload` (400 if invalid), call the gate client, log with `createApiLogger` (safe, no raw email), map gate `500`/`502`/`504` to the same status with a user-safe English message (depends on T007, T008)
- [ ] T010 [P] [US1] Implement the protected page (English copy) in `src/app/services/image-generate/page.js`: prompt textarea + Generate button, loading/pending state that disables submit while in-flight (FR-008), fetch `POST /api/image/generate`, render the returned `image` data URL inline (FR-007), allow re-submit for a new image
- [ ] T011 [P] [US1] Add an "Image Generate" entry to the Services dropdown in `src/components/Navbar.js` (FR-011) linking to `/services/image-generate`

**Checkpoint**: User Story 1 fully functional and testable independently (generate flow end-to-end with a reachable gate).

---

## Phase 4: User Story 2 - Route is protected and requires authentication (Priority: P1)

**Goal**: Unauthenticated users cannot view the page or call the API; they are redirected to login and returned afterward. Covers FR-002, FR-005 (page + API defense in depth).

**Independent Test**: Open `/services/image-generate` signed out → redirected to login; `POST` the API without a session → `401`.

### Tests for User Story 2

- [ ] T012 [P] [US2] Integration test: `POST /api/image/generate` without a session → `401` and the gate is NOT called (add to `src/tests/api/image-generate.integration.test.js`)
- [ ] T013 [US2] E2E test: unauthenticated navigation to `/services/image-generate` redirects to `/login` with a redirect back to the page; and the Services nav shows the "Image Generate" entry (new `e2e/image-generate.spec.js`, reuse `signInWithMagicLink`)

### Implementation for User Story 2

- [ ] T014 [US2] Add `/services/image-generate` to the `privateRoutes` allowlist in `src/lib/auth.tsx` so the client `RequireAuth` gate redirects unauthenticated visitors to login (FR-002)
- [ ] T015 [US2] Confirm the page in `src/app/services/image-generate/page.js` is wrapped by the app-level `RequireAuth` (Providers) so no redirect-to-login gap remains; verify the API route's `readSession` guard returns `401` before any gate call (FR-005)

**Checkpoint**: User Stories 1 AND 2 both work independently (generation works when signed in; access is blocked/redirected when signed out).

---

## Phase 5: User Story 3 - Errors and edge cases handled gracefully (Priority: P2)

**Goal**: Clear feedback for empty/invalid prompts, gate failures, and timeouts; the gate/ComfyUI host/port is never exposed to the client. Covers FR-004 (client), FR-009, FR-010, FR-012.

**Independent Test**: Submit an empty prompt (validation, no request sent); with the gate down, confirm a clear error and a working retry; confirm no gate/ComfyUI host/port in HTML/network/client JS.

### Tests for User Story 3

- [ ] T016 [P] [US3] Integration test: with a session, empty prompt → `400` and gate NOT called; stubbed gate `502`/`504` → the same status surfaced with a user-safe message (add to `src/tests/api/image-generate.integration.test.js`)
- [ ] T017 [US3] E2E test: with the gate down, submitting a valid prompt reaches a clear error state (no infinite spinner) and the user can retry; assert no network request targets the gate host/port and the response body contains no gate/ComfyUI host/port (extend `e2e/image-generate.spec.js`)

### Implementation for User Story 3

- [ ] T018 [US3] Add client-side validation + English error messages to `src/app/services/image-generate/page.js`: block empty/whitespace submit (FR-004), show the API error message on failure, re-enable submit for retry (FR-009)
- [ ] T019 [US3] Verify/ensure the API route `src/pages/api/image/generate.js` never returns the gate base URL in the body and applies a bounded request timeout so a down/slow gate yields a clear error (FR-009, FR-010); confirm `GPU_GATE_URL` is the single source for the host/port (FR-012)

**Checkpoint**: All user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Whole-feature verification gates.

- [ ] T020 Run `npm run lint` and `npm run build`; fix any errors (Constitution IV)
- [ ] T021 Run the full unit + integration suite (`npm run test:unit`, `npm run test:integration`) and confirm green
- [ ] T022 Run E2E (`npm run test:e2e -- e2e/image-generate.spec.js`) and confirm redirect, nav entry, and terminal-state assertions
- [ ] T023 Run the manual smoke against the live gate (`quickstart.md` §5): real generation renders; DevTools shows only `/api/image/generate` as the image source; gate/ComfyUI host/port never exposed (SC-005)
- [ ] T024 Run the `quickstart.md` Definition-of-Done table and record outcomes against SC-001…SC-005

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **User Stories (Phase 3+)**: All depend on Foundational. US1 → US2 → US3 in priority order (US2/US3 refine files introduced by US1).
- **Polish (Phase 6)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — core generate flow.
- **US2 (P1)**: After US1 (adds the client `RequireAuth` gate + verifies the API guard already present in US1).
- **US3 (P2)**: After US1/US2 (adds validation + error states to the same page/API).

### Within Each User Story

- Write failing tests first where declared (US1 payload helper, US1/US2 `401`, US2 redirect).
- Modules before endpoints before page.
- Core implementation before integration/error handling.

### Parallel Opportunities

- T003–T004 (env + accessor) and T005–T006 (tests) can start together once Setup is confirmed.
- Within US1: T007 (payload) and T008 (gate client) are independent files — parallel; T010 (page) and T011 (navbar) are independent of the API route — parallel.
- Test tasks marked [P] run in parallel with their implementation targets.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: unit + integration (US1 subset) + a live-gate manual generation.
5. Deploy/demo if ready (MVP: signed-in user generates an image).

### Incremental Delivery

1. Setup + Foundational → Foundation ready.
2. US1 → Verify independently → MVP.
3. US2 (protection) → Verify independently (redirect + 401).
4. US3 (errors/edge cases) → Verify independently.
5. Phase 6 polish (lint/build + full test suite + E2E + manual smoke).

### Notes

- [P] tasks = different files, no dependencies.
- The page and API are introduced in US1 and refined in US2/US3 (small feature → shared files); keep edits scoped per phase to avoid conflicts.
- Stop at any checkpoint to validate the story independently.
- Commit after each logical group (pause before commit/deploy per Constitution VI).

---

## Phase 7: Rate limiting, retained history, and retry

- [ ] T025 Add unit coverage for atomic per-user Redis limiting and integration coverage for `429` + `Retry-After` with no job creation.
- [ ] T026 Implement `src/lib/image-generate/rate-limit.js`; configure `IMAGE_GEN_RATE_LIMIT_MAX` and `IMAGE_GEN_RATE_LIMIT_WINDOW_SECONDS` in `.env.example`.
- [ ] T027 Make job retention configurable through `IMAGE_GEN_RETENTION_DAYS` (default 30), retain `promptId`, and add owner-scoped recent-history queries.
- [ ] T028 Add authenticated `GET /api/image/generate/history`; enrich owner-only job responses with retained prompt and negative prompt for retry.
- [ ] T029 Add page history UI with Load and Try again controls; retries create fresh jobs and use the same rate limit.
- [ ] T030 Run focused/full tests, lint, build, and authenticated runtime checks for rate limiting, history isolation, loading, and retry.
