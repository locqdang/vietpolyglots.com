# Feature Specification: Image Generate Service

**Feature Branch**: `007-image-generate`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Protected route under Services called Image Generate. Users must log in to use it. A form lets the user describe what they want to see in the image. It makes an API request to the local ComfyUI instance (port 8189) to generate the image." Clarification: port 8189 is the **GPU gate** (`gpu-gate`), the mandatory inference client in front of ComfyUI. The app calls the gate's **Chroma API** (`POST /api/chroma/generate`); it does not talk to ComfyUI directly and does not build workflow graphs.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Logged-in user generates an image from a text description (Priority: P1)

A signed-in user opens the Image Generate page, types a description of the image they want to see, submits it, and sees the generated image rendered on the page.

**Why this priority**: This is the core value of the feature — turning a natural-language prompt into a produced image. Without it the feature does not exist.

**Independent Test**: Sign in as any user, open `/services/image-generate`, enter a prompt, submit, and confirm a generated image is displayed. This single flow is a viable MVP.

**Acceptance Scenarios**:

1. **Given** a signed-in user is on the Image Generate page, **When** they enter a non-empty prompt and submit, **Then** the page shows a loading indicator, and after the backend completes generation the resulting image is displayed.
2. **Given** a signed-in user submits a prompt, **When** the request is in flight, **Then** the submit control is disabled or clearly in a pending state so the user does not fire duplicate generations.
3. **Given** the backend returns a generated image, **When** the page receives the response, **Then** the image is displayed inline and the user can submit another prompt to generate a new image.

---

### User Story 2 - Route is protected and requires authentication (Priority: P1)

A user who is not signed in cannot access the Image Generate page or its API; they are redirected to login and return to the page after authenticating.

**Why this priority**: The route is explicitly a protected route. Access control is a hard requirement, not a nicety, and must be enforced on both the page and the API (defense in depth).

**Independent Test**: Open `/services/image-generate` while signed out and confirm a redirect to login; call the generate API without a valid session and confirm a `401`.

**Acceptance Scenarios**:

1. **Given** an unauthenticated visitor, **When** they navigate to `/services/image-generate`, **Then** they are redirected to the login page carrying a redirect target that returns them to the Image Generate page after sign-in.
2. **Given** an unauthenticated caller, **When** they `POST` to the generate API, **Then** the API responds with `401` and no image generation is attempted.
3. **Given** a signed-in user, **When** they navigate to `/services/image-generate`, **Then** the page renders the form without a redirect.

---

### User Story 3 - Generation errors and edge cases are handled gracefully (Priority: P2)

The page and API surface clear, actionable feedback when a prompt is missing or invalid, or when the GPU gate (and the ComfyUI behind it) fails, times out, or is unavailable.

**Why this priority**: ComfyUI is a local, long-running, fallible dependency. Robust error handling keeps the feature usable and debuggable instead of hanging or failing silently.

**Independent Test**: Submit an empty prompt (validation path) and, with ComfyUI stopped or a prompt that errors, confirm the user sees a clear error and can retry.

**Acceptance Scenarios**:

1. **Given** the form, **When** the user submits an empty or whitespace-only prompt, **Then** the request is not sent and a validation message is shown.
2. **Given** a valid signed-in request, **When** the ComfyUI instance is unreachable, **Then** the API returns an error and the page displays a clear message without hanging indefinitely.
3. **Given** a valid signed-in request, **When** generation exceeds the backend timeout, **Then** the API returns a timeout error and the page allows the user to retry.
4. **Given** a signed-in user, **When** the page first loads, **Then** they can see the form and, after a generation, re-submit a new prompt.

---

### Edge Cases

- What happens when the prompt is empty or whitespace-only? (Client-side validation blocks submit; API also rejects with `400`.)
- How does the system handle an oversized or malformed prompt? (Truncated/validated to a maximum length server-side; rejected if invalid.)
- How does the system handle the gate returning a generation error or no output? (API surfaces a generation-failed error; user can retry.)
- How does the system handle the gate being down or slow? (The gate already waits for the render with its own timeout; the app adds a client-side request timeout and maps the gate's `502`/`504` to a clear error.)
- What happens when the user submits rapidly multiple times? (Submit is disabled during an in-flight request to prevent duplicate generations.)
- How are images displayed without exposing the internal GPU gate / ComfyUI host/port to the browser? (The backend returns the image bytes as a data URL; the client never contacts the gate or ComfyUI directly.)

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST expose an Image Generate page at a route under the Services area (e.g. `/services/image-generate`).
- **FR-002**: System MUST require the user to be authenticated to view the page; unauthenticated visitors MUST be redirected to login with a return path to the page.
- **FR-003**: System MUST provide a form with a field for the user to enter a free-text description (prompt) of the image they want.
- **FR-004**: System MUST require a non-empty prompt and prevent submission of an empty/whitespace-only prompt.
- **FR-005**: System MUST submit the prompt to a server-side API endpoint that is itself authenticated (rejects unauthenticated requests with `401`).
- **FR-006**: System MUST call the GPU gate's Chroma API (`POST /api/chroma/generate`) to run a text-to-image generation using the prompt, then fetch the produced image bytes and return them to the page.
- **FR-007**: System MUST display the generated image on the page after a successful generation.
- **FR-008**: System MUST show a loading/pending state while a generation is in flight and prevent duplicate concurrent submissions.
- **FR-009**: System MUST surface clear error feedback for validation failures, backend failures, and timeouts, and allow the user to retry.
- **FR-010**: System MUST keep the GPU gate (and ComfyUI) host and port internal to the server; the browser MUST NOT be able to reach the gate or ComfyUI directly from the page.
- **FR-011**: System MUST add an "Image Generate" entry to the Services navigation so the route is discoverable.
- **FR-012**: System MUST configure the GPU gate base URL from environment configuration so it can be changed without code edits.
- **FR-013**: System MUST log generation activity with safe, non-sensitive context (no raw user email) consistent with existing API logging.
- **FR-014**: User-facing page copy (labels, buttons, messages) MUST be in English. (User explicitly requested English-only UI for this feature, overriding the Constitution V Vietnamese default.) Technical build artifacts remain in English.
- **FR-015**: System MUST enforce an atomic, Redis-backed rate limit per authenticated user before creating or enqueueing a generation. Limit/window values MUST be configurable; rejected requests MUST return `429` with `Retry-After` and MUST NOT create a Mongo or BullMQ job.
- **FR-016**: System MUST persist the gate `prompt_id` with every completed generation and expose it only to the owning user.
- **FR-017**: System MUST provide an owner-scoped recent-generation history showing prompt, `prompt_id`, status, seed, and timestamps without exposing another user's records.
- **FR-018**: A user MUST be able to load a retained completed image from history and start a fresh generation using the retained prompt and negative prompt through a "Try again" action. A retry is a new generation and MUST count against the same rate limit.
- **FR-019**: Generated job/result retention MUST be configurable and default to 30 days; history MUST communicate that retained images may expire.

### Key Entities _(include if feature involves data)_

- **Generation Request**: The user-supplied prompt (plus optional parameters the gate supports — negative prompt, width, height, steps, cfg, seed). Validated and clamped server-side to the gate's accepted ranges.
- **Generation Result**: The produced image (returned to the client as a data URL for display) plus status. No persistent store is required for v1; the result is transient.
- **GPU Gate (Chroma API)**: The `gpu-gate` service on `192.168.0.62:8189` that owns the verified Chroma1-HD workflow, enforces a GPU lease, submits to ComfyUI, waits for the render, and returns output-image metadata with a relative `/view` URL. The app is a thin caller of this API.

## Verification Plan _(mandatory)_

### Required Evidence

- **Unit Tests**: The request-mapping helper (pure function: prompt + optional params → gate Chroma API payload) produces a valid payload for a given prompt and clamps/rejects inputs outside the gate's accepted ranges (prompt length, width/height multiple-of-8 in 256–2048, steps, cfg, seed). Input validation (empty/oversized prompt) is covered.
- **Integration Tests**: The generate API returns `401` without a valid session, `400` for an invalid/empty prompt, and a `2xx` with an image data-URL payload when a valid session and a reachable GPU gate are present (the gate may be stubbed/faked for the contract test).
- **E2E Coverage**: Unauthenticated navigation to the page redirects to login; an authenticated user submits a prompt and the page renders the generated image (or a clear error when the gate is unavailable).
- **Manual Smoke Checks**: With the GPU gate reachable on the configured port, run a real generation from the browser and confirm the image renders and the gate/ComfyUI host/port are never exposed to the client.

### Test-First Expectations

- The request-mapping helper (build the gate Chroma payload from prompt + params) should begin with a failing unit test, since it is stable, pure, and cheaply expressed.
- The API auth gate (`401` without session) should begin with a failing integration test, since it is a clear, stable permission rule.
- E2E for the full browser flow is verified after implementation because it depends on the live GPU gate runtime.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A signed-in user can produce a displayed image from a text prompt on the Image Generate page in a single submit.
- **SC-002**: Unauthenticated access to the page redirects to login; unauthenticated API calls return `401` in 100% of cases.
- **SC-003**: Empty/whitespace prompts are rejected without reaching the GPU gate.
- **SC-004**: When the GPU gate is down or slow, the user sees a clear error within the request timeout bound and can retry (no infinite hang).
- **SC-005**: The GPU gate / ComfyUI host and port never appear in page HTML, network responses, or client-side code.

## Assumptions

- The existing authentication system (JWT in an HttpOnly session cookie, `readSession` server guard, `RequireAuth` client guard, `privateRoutes` allowlist) is reused without modification.
- The GPU gate (`gpu-gate`) is the sole inference client in front of ComfyUI and is reachable by the server at a base URL supplied via environment configuration (`GPU_GATE_URL`), defaulting to `http://192.168.0.62:8189` (the gate's LAN address on `192.168.0.62`, port `8189`). The app does not talk to ComfyUI directly.
- The gate exposes a stable Chroma generation endpoint, `POST /api/chroma/generate`, that accepts `{ prompt, negative_prompt?, width?, height?, steps?, cfg?, seed? }`, builds and submits the verified Chroma1-HD workflow, waits for the render, and returns `{ status: "success", prompt_id, seed, images: [ { filename, subfolder, type, url } ] }` where `url` is a relative `/view?...` path. Error responses use the gate's own status codes (`400` invalid, `500` generation failed, `502` ComfyUI unavailable, `504` timeout).
- The gate owns the workflow (checkpoint, `t5xxl_fp8_chroma_fixed` CLIP encoder of `chroma` type, sampler, VAE decode, save). The app does not build or modify the node graph; it only supplies prompt and generation parameters.
- Image bytes are fetched server-side from the gate's relative `url` field (resolved against the gate base URL), base64-encoded, and returned to the client as a data URL. The client never contacts the gate or ComfyUI.
- No persistent storage of generated images is required for v1; results are transient and displayed in the session.
- Generation parameters beyond the prompt (negative prompt, dimensions, steps, cfg, seed) are optional for v1 and use the gate's defaults; they may be exposed as advanced form fields later.
- The feature is user-facing, so page copy is in English (user-requested); specs, plan, tasks, and code comments remain in English.
