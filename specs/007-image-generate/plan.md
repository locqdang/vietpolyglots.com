# Implementation Plan: Image Generate Service

**Branch**: `007-image-generate` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-image-generate/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Add a protected **Services → Image Generate** page to vietpolyglots.com. A signed-in user types a free-text description of the image they want, submits it, and sees the generated image rendered on the page. Generation is performed by the **GPU gate** (`gpu-gate`, `192.168.0.62:8189`) — the sanctioned inference client in front of ComfyUI — reached **only from the server** through a new authenticated API route that calls the gate's Chroma API (`POST /api/chroma/generate`) and returns the image as a data URL. The app never talks to ComfyUI directly and never builds a workflow graph; the browser never contacts the gate or ComfyUI directly. Access is gated on the existing JWT-cookie auth (`RequireAuth` client guard + `readSession` server guard), and the gate base URL is environment-configured.

## Technical Context

**Language/Version**: TypeScript + JavaScript on Node (Next.js 16.1.6, React 19). New files follow existing conventions: API routes in plain JS (`src/pages/api/**`), App Router pages in `'use client'` JS (`src/app/**`).

**Primary Dependencies**:
- `next` (App Router page + Pages Router API route), `react`
- Existing auth: `src/lib/auth/session.js` (`readSession`), `src/lib/auth.tsx` (`RequireAuth`, `privateRoutes`)
- Existing logging: `src/lib/api-logging.js` (`createApiLogger`), `src/lib/logger.js` (`serializeError`)
- No new runtime dependencies required. Node 18+ global `fetch` is used for the gate call and the image-bytes fetch.

**Storage**: N/A for v1 — generation results are transient (returned to the client, not persisted). No DB schema changes.

**Testing**:
- Unit: `vitest` (pure request-mapping helper + input validation)
- Integration: `vitest` (API route auth/validation contract, GPU gate stubbed)
- E2E: `@playwright/test` against `http://127.0.0.1:3100`, reusing `e2e/helpers/route-auth.js` (`signInWithMagicLink`)

**Target Platform**: Linux server (Next.js production build) + browser. The GPU gate runs on the LAN (`192.168.0.62:8189`) and is reachable only by the server process; the browser never reaches it.

**Project Type**: Web application (Next.js, mixed App Router + Pages Router).

**Performance Goals**: A single generation is a single blocking request to the gate (the gate waits for the render with its own timeout). The app adds a client-side request timeout (default ≤ 120 s) so a down/slow gate cannot hang the request indefinitely. No throughput target — single-user interactive tool.

**Constraints**:
- The GPU gate / ComfyUI host:port MUST NOT appear in page HTML, client JS, or any client-visible network response (FR-010, SC-005).
- The app MUST delegate generation entirely to the gate's `POST /api/chroma/generate`; it MUST NOT build/submit a ComfyUI node graph (R0/I7).
- The request to the gate MUST be bounded by a client-side timeout so a down/slow gate cannot hang the request indefinitely (SC-004).
- Page copy is in English (user-requested, overriding Constitution V's Vietnamese default); build artifacts stay English.
- Must pass `npm run lint` and `npm run build` before done (Constitution IV).

**Scale/Scope**: 1 new page, 1 new API route, a small server-side helper module (payload mapping + gate client), nav + auth-list edits, env config, and tests.

## Verification Strategy

**Lead Test Decision**:

- **Unit**: The request-mapping helper (pure function: prompt + optional params → gate Chroma payload) and input validation (empty/whitespace/oversized prompt rejected; out-of-range numerics rejected). Test-first.
- **Integration**: `POST /api/image/generate` returns `401` without a session, `400` for an invalid/empty prompt, and `2xx` with an image data-URL when a valid session + reachable (stubbed) GPU gate are present. Test-first on the `401` gate.
- **E2E**: (a) unauthenticated navigation to `/services/image-generate` redirects to `/login`; (b) authenticated user submits a prompt and the page reaches a terminal state (image rendered when the gate is up, or a clear error state when it is down); (c) the Services nav shows an "Image Generate" entry.
- **Manual Smoke**: With the GPU gate reachable on the configured host/port, run a real generation from the browser and confirm the image renders; confirm the gate/ComfyUI host/port never appears in the page source or network panel.

**Test-First Targets**:
- Request-mapping helper produces a valid gate payload and clamps/validates inputs (pure, stable).
- API `401` without session (clear permission rule).

## Constitution Check

_Gate: Must pass before Phase 0 research. Re-check after Phase 1 design._

- Spec or ticket exists and scope is explicit. ✅ `spec.md` written with FRs, edge cases, success criteria.
- Verification strategy is defined by Lead before implementation. ✅ Unit/integration/E2E/smoke defined above.
- Test-first targets are identified when behavior is clear enough. ✅ Request-mapping helper + `401` gate.
- User-facing flows needing browser or E2E proof are identified. ✅ Page render, auth redirect, nav entry.
- Observability, review pause, and deploy smoke requirements are captured. ✅ `createApiLogger` (safe, no raw email); review pause before commit/deploy per Constitution VI.

**Result: PASS** — no violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/007-image-generate/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── image-generate-api.md
└── tasks.md             # Phase 2 output (/speckit-tasks - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── app/
│   └── services/
│       └── image-generate/
│           └── page.js            # NEW: 'use client' protected page (form + result)
├── pages/
│   └── api/
│       └── image/
│           └── generate.js        # NEW: POST, readSession guard, calls the gate
├── lib/
│   └── image-generate/
│       ├── payload.js             # NEW: pure buildChromaPayload(request) -> gate payload + validation
│       └── gate-client.js         # NEW: server-side only; POST /api/chroma/generate + fetch image bytes
│   └── auth.tsx                   # EDIT: add '/services/image-generate' to privateRoutes
└── components/
    └── Navbar.js                  # EDIT: add Image Generate to Services dropdown

.env / .env.example                # EDIT: add GPU_GATE_URL (default http://192.168.0.62:8189)

# Tests
src/tests/
├── lib/image-generate-payload.test.js     # NEW: unit (payload mapping + validation)
└── api/image-generate.integration.test.js # NEW: integration (auth/validation/contract, gate stubbed)
e2e/
├── image-generate.spec.js         # NEW: auth redirect + generate flow
└── navbar-services.spec.js        # EDIT (or new case): Image Generate entry present
```

**Structure Decision**: Follows the existing mixed-Next.js layout — App Router page under `src/app/services/image-generate/`, Pages Router API route under `src/pages/api/image/`, small server-only helper under `src/lib/image-generate/` (a pure payload-mapping function plus a gate client that never runs in the browser), tests under `src/tests/` (unit + integration, vitest) and `e2e/` (Playwright). This mirrors `src/app/haro/**` + `src/pages/api/haro/**` + `src/tests/**` already in the repo. No new packages. The app deliberately has **no** ComfyUI workflow builder or `/history` poller — those belong to the GPU gate.

## Complexity Tracking

> Not required — Constitution Check passed with no violations.
