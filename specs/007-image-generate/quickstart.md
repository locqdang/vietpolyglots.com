# Quickstart: Image Generate Service

Feature: `007-image-generate`. Runnable validation scenarios that prove the feature works end-to-end. Implementation details live in [plan.md](./plan.md) and (later) `tasks.md`; this is the **run/verify** guide.

## Prerequisites

1. **Dependencies installed** — `npm install` (no new packages are added by this feature).
2. **Env configured** — `GPU_GATE_URL` set in `.env` (and documented in `.env.example`).
   - Default: `GPU_GATE_URL=http://192.168.0.62:8189` (the GPU gate's LAN address — the gate is bound on `192.168.0.62`, so `localhost:8189` will **not** work).
3. **GPU gate reachable** (for live/E2E-success scenarios only). The gate runs the Chroma pipeline in front of ComfyUI and owns the GPU lease. Unit and integration tests stub the gate and do **not** require it running.
4. **A logged-in user** for manual/E2E authenticated flows. E2E mints one via the existing test helper (`e2e/helpers/route-auth.js` → `signInWithMagicLink`, which calls `/api/test/generate-login-link`).

> Quick reachability check (no GPU burned): `curl -s -o /dev/null -w "%{http_code}\n" $GPU_GATE_URL/` should print `200`; `curl -s -X POST $GPU_GATE_URL/api/chroma/generate -H 'Content-Type: application/json' -d '{}'` should return a `400` "prompt is required" — both confirm the gate is up without running a model.

## 1. Unit tests (payload mapping + validation) — no gate needed

```bash
npm run test:unit -- src/tests/lib/image-generate-payload.test.js
```

**Expected**: all pass.
- `buildChromaPayload` produces a valid gate Chroma payload (prompt trimmed; optional params passed through only when provided) for a prompt.
- Empty/whitespace/oversized prompt is rejected per [data-model.md](./data-model.md).
- Out-of-range numerics (e.g. `width` not a multiple of 8, `steps` > 100) are rejected.

## 2. Integration tests (API contract) — GPU gate stubbed

```bash
npm run test:integration -- src/tests/api/image-generate.integration.test.js
```

**Expected** (see [contracts/image-generate-api.md](./contracts/image-generate-api.md)):
- `POST` without a session → `401`, and the gate is **not** called.
- `POST` with a session but empty prompt → `400`, and the gate is **not** called.
- `POST` with a session + valid prompt + stubbed gate → `200` with `image` (data URL), `promptId`, `seed`.
- Stubbed gate `500`/`502`/`504` → the same status is surfaced with a user-safe message.

## 3. Lint + build (Constitution IV gate)

```bash
npm run lint
npm run build
```

**Expected**: both exit `0` with no errors. (Build compiles the new page + API route; lint covers the new files.)

## 4. E2E (Playwright) — browser flow

```bash
npm run test:e2e -- e2e/image-generate.spec.js
```

The Playwright config auto-starts the dev server on `http://127.0.0.1:3100` (`E2E_TEST_MODE=1`).

**Expected**:
- **Unauthenticated** navigation to `/services/image-generate` → redirected to `/login?redirect=%2Fservices%2Fimage-generate`.
- **Authenticated** (via `signInWithMagicLink`): page renders the prompt form + Generate button; submit reaches a terminal state:
  - With the gate up → an `<img>` with the generated result appears.
  - With the gate down → a clear English error message appears (no infinite spinner).
- **Nav**: the Services dropdown contains an **Image Generate** entry (extend/verify via `e2e/navbar-services.spec.js`).

> If the gate is not running, the authenticated "success" assertion should be relaxed to the error-state assertion (SC-004). Keep the redirect and nav assertions unconditional.

## 5. Manual smoke (live GPU gate)

1. Ensure the gate is reachable on `GPU_GATE_URL`, then `npm run dev`.
2. Sign in, open **Services → Image Generate**.
3. Type a prompt (e.g. "a watercolor red dragon over mountains at sunrise") and click Generate.
4. **Confirm**:
   - An image renders on the page.
   - While generating, the button is disabled/pending (no duplicate fires).
   - In DevTools → Network, the only image request is to `/api/image/generate`; **no** request to `192.168.0.62:8189` and no gate/ComfyUI host/port in the response body (SC-005 / I1).
   - Submit an empty prompt → client-side validation message, no request sent (SC-003).

## Definition of done (maps to spec Success Criteria)

| # | Check | SC |
|---|-------|----|
| 1 | Signed-in user gets a displayed image from a prompt in one submit | SC-001 |
| 2 | Unauth page → login redirect; unauth API → `401` | SC-002 |
| 3 | Empty prompt rejected without reaching the gate | SC-003 |
| 4 | Down/slow gate → bounded error + retry (no hang) | SC-004 |
| 5 | Gate/ComfyUI host/port never in HTML/network/client JS | SC-005 |
