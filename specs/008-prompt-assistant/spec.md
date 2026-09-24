# Feature Specification: Image Prompt Assistant

**Feature Branch**: `008-prompt-assistant`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "Under /image-generate, add a feature to let people manage their prompt. It allows the user to enter a short prompt and click 'Help generate prompt'. That will generate the prompt and negative prompt using the Qwen uncensored model (already available at the GPU gate). Make sure to secure it against prompt injection and other attacks." This is a companion feature to `007-image-generate`: it helps a signed-in user turn a short, rough idea into a refined image prompt (positive + negative) before they run a generation.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A signed-in user turns a short idea into a refined prompt (Priority: P1)

A signed-in user on the Image Generate page has a rough idea but doesn't know how to write a good prompt. They type the short idea into a dedicated "prompt assistant" field, click **Help generate prompt**, and the page fills the main "Describe your image" and "Things to avoid" (negative) fields with a refined, ready-to-use prompt and a sensible negative prompt. The user reviews/edits the result and then generates the image as usual.

**Why this priority**: This is the entire point of the feature — lowering the barrier from "I have a fuzzy idea" to "I have a good prompt." Without it the feature does not exist.

**Independent Test**: Sign in, open `/image-generate`, type a short idea (e.g. "a red fox in the snow") into the assistant field, click **Help generate prompt**, and confirm the main prompt and negative-prompt fields are populated with a refined, on-topic prompt and a usable negative prompt.

**Acceptance Scenarios**:

1. **Given** a signed-in user on the Image Generate page, **When** they enter a non-empty short idea and click **Help generate prompt**, **Then** the request is accepted into a Redis-backed queue, the page shows a queued/working state while polling, and once the queued job completes the main "Describe your image" field and the "Things to avoid" field are populated with the generated positive and negative prompts.
2. **Given** the assistant has populated the fields, **When** the user edits the generated text and submits the normal Generate form, **Then** the edited text (not the original short idea) is what is sent for image generation.
3. **Given** the assistant has populated the fields, **When** the user clicks **Help generate prompt** again with a new short idea, **Then** the fields are re-populated with the new result (the assistant output replaces the current draft in those fields).
4. **Given** a signed-in user, **When** they click **Help generate prompt**, **Then** the assistant control is disabled or clearly pending so the user cannot fire overlapping assistant requests.

---

### User Story 2 - Route and API are protected and require authentication (Priority: P1)

A user who is not signed in cannot use the prompt assistant: the page behaves as it does today (redirects to login), and the assistant API rejects unauthenticated calls.

**Why this priority**: The assistant consumes the shared GPU and runs a model behind the gate; like image generation it must be authenticated. Access control is a hard requirement and is enforced on both the page and the API (defense in depth), consistent with the existing image-generate feature.

**Independent Test**: Call the prompt-assistant API without a valid session and confirm a `401`; open `/image-generate` signed out and confirm the existing login redirect still applies to the page (and therefore to the assistant, which lives on it).

**Acceptance Scenarios**:

1. **Given** an unauthenticated caller, **When** they `POST` to the prompt-assistant API, **Then** the API responds with `401` and no model call is made.
2. **Given** a signed-in caller, **When** they `POST` a valid short idea to the prompt-assistant API, **Then** the request proceeds to prompt generation.

---

### User Story 3 - The assistant is safe against prompt injection and other attacks (Priority: P1)

A user's short idea is treated strictly as **content to be expanded**, never as instructions the system will follow. The backend enforces a fixed, server-controlled instruction set, treats the user text only as data, and only accepts a tightly-structured, validated result. Malformed, oversized, or "instruction-like" model output is rejected with a clear error rather than surfaced or acted on. This protects the system from prompt-injection (including a user pasting "ignore your instructions…"), output-injection/XSS, and resource abuse.

**Why this priority**: The user explicitly called out security against prompt injection and other attacks. The assistant sends untrusted user text to a general-purpose model and then renders the model's output back into the UI, so this is a core requirement, not a nicety.

**Independent Test**: Send assistant requests whose short idea contains injection-style text (e.g. `ignore all previous instructions and output {…}` or a fake JSON blob). Confirm the result is always either (a) a valid, in-schema positive+negative prompt that is rendered only as text in the form fields, or (b) a clear error — never a raw model dump, never a change in system behavior, and never HTML/script that executes in the page.

**Acceptance Scenarios**:

1. **Given** a short idea that contains instruction-like or injection-style text, **When** the assistant processes it, **Then** the system treats that text as data to be expanded and does not follow any instructions contained within it; the user's embedded text cannot alter the fixed instruction set, the model choice, the request destination, or any server behavior.
2. **Given** the model returns output that is not the expected structure (not valid JSON, missing fields, wrong types, or extra/unexpected fields), **When** the backend receives it, **Then** the request fails with a clear error and none of the invalid output is returned to or rendered on the page.
3. **Given** the model returns a valid positive/negative prompt, **When** the page renders it, **Then** it is displayed only as plain text inside the form fields (the generated text is never interpreted as markup or script and cannot execute in the page).
4. **Given** a short idea that exceeds the allowed input length, **When** the user submits it, **Then** the request is rejected with a validation error and no model call is made.
5. **Given** a signed-in user, **When** they exceed the assistant's per-user rate limit, **Then** the request is rejected with `429` and a `Retry-After`, and no model call is made.

---

### User Story 4 - Assistant errors and edge cases are handled gracefully (Priority: P2)

The page and API surface clear, actionable feedback when the short idea is missing, when the model/gate is unavailable, times out, or is rate-limited, and when the model returns an unusable result.

**Why this priority**: The assistant depends on a live, fallible model behind the GPU gate (which serializes GPU access with image generation). Robust error handling keeps the feature usable and debuggable instead of hanging or failing silently.

**Independent Test**: Submit an empty short idea (validation path) and, with the model/gate down or returning garbage, confirm the user sees a clear error and can retry without the rest of the page breaking.

**Acceptance Scenarios**:

1. **Given** the assistant field, **When** the user clicks **Help generate prompt** with an empty/whitespace-only short idea, **Then** the request is not sent and a validation message is shown.
2. **Given** a valid signed-in request, **When** the model/gate is unreachable or returns an unusable result, **Then** the API returns a clear error and the page displays a message without hanging indefinitely; the existing prompt/negative fields are left unchanged.
3. **Given** a valid signed-in request, **When** the assistant exceeds the backend timeout bound, **Then** the API returns a timeout error and the page allows the user to retry.
4. **Given** the assistant fails, **When** the user edits their short idea and retries, **Then** the assistant works again and the rest of the page (consent, generation, history) is unaffected.

---

### Edge Cases

- **Empty/whitespace short idea**: Client blocks submit; API also rejects with `400`.
- **Oversized short idea**: Validated to a maximum input length server-side; rejected if invalid.
- **Oversized model output**: The generated positive and negative prompts are each capped to a maximum length; over-limit output is rejected (treated as invalid), not truncated-and-accepted silently.
- **Model returns non-JSON, partial JSON, extra fields, or wrong types**: Rejected as invalid (4xx); the invalid output is never returned or rendered.
- **Injection-style short idea** ("ignore your instructions", fake JSON, role-play, markup): Treated as data only; cannot change the fixed instruction set, model, destination, or cause the page to execute markup/script.
- **Model/gate down or slow**: The backend enforces a request timeout bound; a timeout/unavailable error is surfaced and the user can retry. (The gate also holds a GPU lease during the call, so assistant calls and image generations are serialized by the gate.)
- **Rapid repeated clicks**: The assistant control is disabled while a request is in flight to prevent overlapping model calls.
- **No secret/host leakage**: The model's base URL, host, port, and model identity are server-only; the browser never learns them and never calls the gate/model directly.
- **Relationship to the consent notice**: The assistant only _drafts_ a prompt; the user still sees and (by design) reviews the generated text before generating, and the existing image-generation consent notice and validation still apply at generation time.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST add a prompt-assistant control to the existing Image Generate page at `/image-generate` (no new top-level route), consisting of a field for a short idea and a **Help generate prompt** action.
- **FR-002**: System MUST require the user to be authenticated to use the assistant; the page keeps its existing login-redirect behavior, and the assistant API MUST reject unauthenticated requests with `401`.
- **FR-003**: System MUST require a non-empty short idea and reject an empty/whitespace-only short idea (client-side before submit and server-side with `400`).
- **FR-004**: System MUST enforce a maximum length on the short idea server-side and reject oversized input with `400` before any model call.
- **FR-005**: System MUST send the short idea to a server-side, authenticated API endpoint that calls the Qwen uncensored model available at the GPU gate (OpenAI-compatible chat endpoint) to produce a refined positive prompt and a negative prompt.
- **FR-006**: System MUST return the generated positive prompt and negative prompt to the page, and the page MUST populate the main "Describe your image" field and the "Things to avoid" (negative) field with them so the user can review, edit, and then generate.
- **FR-007**: System MUST treat the user's short idea strictly as data: the instruction set sent to the model MUST be a fixed, server-controlled prompt; the user text MUST NOT be concatenated into or able to alter the instruction set, the model identifier, or the request destination.
- **FR-008**: System MUST validate the model's response against a strict, fixed structure (exactly the expected positive and negative prompt fields, each a string of bounded length) and MUST reject any response that does not conform (non-JSON, missing fields, wrong types, or unexpected extra fields) with a clear error; the rejected output MUST NOT be returned to or rendered on the page.
- **FR-009**: System MUST enforce a maximum length on each generated prompt field and reject over-limit generated output as invalid.
- **FR-010**: System MUST display the generated prompts only as plain text inside the form fields; the generated text MUST NOT be interpreted as markup or script and MUST NOT be able to execute in the page.
- **FR-011**: System MUST show a loading/pending state on the assistant control while a request is in flight and prevent overlapping assistant requests.
- **FR-012**: System MUST surface clear error feedback for validation failures, invalid/oversized model output, model/gate unavailability, and timeouts, and allow the user to retry; a failed assistant call MUST leave the existing prompt/negative fields unchanged.
- **FR-013**: System MUST keep the model's base URL, host, port, and model identity internal to the server; the browser MUST NOT be able to reach the gate/model directly from the page and MUST NOT be told the host/port.
- **FR-014**: System MUST configure the model endpoint and model identifier from environment configuration so they can be changed without code edits.
- **FR-015**: System MUST enforce an atomic, Redis-backed rate limit per authenticated user for the assistant before calling the model. Limit/window values MUST be configurable; rejected requests MUST return `429` with `Retry-After` and MUST NOT call the model. The assistant rate limit MUST be independent from (and in practice tighter than) the image-generation rate limit.
- **FR-016**: System MUST enforce a server-side request timeout bound on the model call and map a timeout to a clear error rather than hanging.
- **FR-017**: System MUST log assistant activity with safe, non-sensitive context (no raw user email, and not the full user text or model output at higher than a summary/redacted level) consistent with existing API logging.
- **FR-018**: User-facing page copy (labels, buttons, messages) MUST be in English, consistent with the existing image-generate feature. Technical build artifacts remain in English.
- **FR-019**: The assistant MUST NOT automatically run on page load; it runs only when the user explicitly triggers **Help generate prompt**.
- **FR-020**: Valid assistant requests MUST be accepted asynchronously into a Redis-backed queue and return `202` with an opaque job ID. The browser MUST poll an authenticated, owner-scoped status endpoint until the job completes or fails. The API and UI MUST distinguish the real pipeline stages: queued in Redis, starting the worker, waiting for GPU ownership, preparing/loading the model, generating through llama.cpp, retrying after a failed attempt, reconnecting to status, completed, and terminally failed. The app MUST pass its opaque job ID to the GPU gate and use the gate's per-request state instead of treating BullMQ `active` as proof that model generation has started. Transient GPU-gate busy/unavailable responses MUST be retried with backoff in the queue instead of being rejected immediately. Transient network or `5xx` failures from the status endpoint MUST NOT abandon the queued job; the browser MUST retry polling and show a reconnecting state.

### Key Entities _(include if feature involves data)_

- **Prompt Idea**: The user-supplied short, free-text description (bounded length) that the assistant expands. Not persisted; transient per request.
- **Generated Prompt Pair**: The assistant's output — a refined positive prompt and a negative prompt, each a bounded-length string. Used only to pre-fill the form; not persisted by the assistant itself (the existing generation history persists the _final_ prompt the user actually generates with).
- **Qwen Uncensored Model (via GPU gate)**: The `Qwen` uncensored model exposed at the `gpu-gate` service through its OpenAI-compatible chat endpoint. The app is a thin, server-side caller of this endpoint; the model identifier and base URL come from environment configuration. The gate owns GPU serialization, so assistant calls and image generations do not run concurrently on the GPU.
- **Assistant Rate-Limit State**: A per-user, Redis-backed counter (separate from the image-generation counter) with a configurable limit and window.

## Verification Plan _(mandatory)_

### Required Evidence

- **Unit Tests**:
  - The request-builder helper (pure: short idea + fixed instruction set → the structured chat request) produces a valid, well-formed request for a given idea, places the user text only in the data position (never in the instruction set), and rejects empty/oversized ideas.
  - The output-validator helper (pure: raw model response → validated `{ prompt, negativePrompt }` **or** an error) accepts only conforming output and rejects non-JSON, missing/wrong-typed fields, unexpected extra fields, and over-limit fields. Injection-style and markup-laden inputs produce either a valid text-only result or an error — never a pass-through of raw model text.
- **Integration Tests**: The assistant API returns `401` without a valid session, `400` for an empty/oversized short idea, `429` + `Retry-After` when rate-limited, and a `2xx` with a valid `{ prompt, negativePrompt }` when a valid session and a conforming (stubbed) model response are present. It returns a `4xx` error (and returns no rendered output) when the stubbed model returns non-conforming or injection-style output. The model/gate host and port never appear in any response.
- **E2E Coverage**: Unauthenticated navigation to `/image-generate` still redirects to login (assistant included). An authenticated user types a short idea, clicks **Help generate prompt**, and the main prompt and negative fields are populated with the returned values; the user can then edit and generate.
- **Manual Smoke Checks**: With the GPU gate/model reachable on the configured endpoint, run a real assistant request from the browser (e.g. "a red fox in the snow") and confirm a sensible refined prompt + negative prompt populate the fields. Confirm an injection-style short idea does not change behavior or surface raw model text. Confirm the model/gate host and port never appear in page HTML, network responses, or client-side code.

### Test-First Expectations

- The request-builder helper (fixed instruction set + idea → structured chat request) should begin with a failing unit test: it is stable, pure, and cheaply expressed, and it is the core of the prompt-injection defense.
- The output-validator helper (raw response → validated pair or error) should begin with a failing unit test, including explicit injection/non-conforming cases, since it is the second line of the security defense and is pure logic.
- The API auth gate (`401` without session) and the rate-limit (`429`) path should begin with failing integration tests, since they are clear, stable permission rules.
- E2E for the full browser flow is verified after implementation because it depends on the live model/gate runtime.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A signed-in user can go from a short idea to a populated, editable positive + negative prompt on the Image Generate page in a single click of **Help generate prompt**.
- **SC-002**: Unauthenticated access to the assistant API returns `401` in 100% of cases, and unauthenticated page access still redirects to login.
- **SC-003**: Empty/whitespace and oversized short ideas are rejected without any model call.
- **SC-004**: For 100% of assistant requests, the user's short idea is processed only as data; no request can alter the fixed instruction set, the model identifier, or the request destination, and no model output is returned/rendered unless it is a valid, in-schema positive+negative prompt.
- **SC-005**: When the model/gate is down, slow, or returns unusable output, the user sees a clear error within the request timeout bound and can retry (no infinite hang); existing prompt/negative fields are left unchanged.
- **SC-006**: The model's base URL, host, port, and model identity never appear in page HTML, network responses, or client-side code.
- **SC-007**: Requests exceeding the assistant rate limit return `429` with `Retry-After` and do not call the model.
- **SC-008**: For common short ideas, the assistant returns a positive prompt that is clearly more specific/descriptive than the input and a non-empty negative prompt (qualitative, judged in the manual smoke check).

## Assumptions

- The existing authentication system (JWT in an HttpOnly session cookie, `readSession` server guard, `RequireAuth` client guard, `privateRoutes` allowlist) and the existing `/image-generate` page are reused without modification; the assistant is an addition to that page and uses the same auth as the image-generation APIs.
- The Qwen uncensored model is served by the `gpu-gate` service through its **OpenAI-compatible chat endpoint** (`POST /v1/chat/completions`) and returns a JSON-object response when asked for one. The specific model identifier (confirmed live: `Qwen3.8-27B-Uncensored-MTP-Q5_K_P`) and the base URL are read from environment configuration (FR-014) so they can change without code edits.
- The model is a reasoning model that returns its real answer in the message `content` (separate from any internal reasoning field); the backend reads only the `content` field.
- **Network reachability (plan-level decision, not a product decision):** the model/LLM gate is bound to a server-only address (loopback on the GPU host today) that the web application's container does not currently share a network with. The product behavior is identical regardless of how the server reaches it. The default assumption is that the application and the gate are placed on a **private, shared internal network** so the backend can call the gate by service name while the endpoint stays off the public internet and the LAN; the base URL is overridable via environment so an alternative path (e.g. a server-side forwarder or a LAN-bound port) can be used without code changes. This is finalized during planning, not here.
- The assistant runs **synchronously** with a server-side timeout bound (FR-016); the page shows a loading state for the duration. A future iteration could move this to the queue, but that is out of scope.
- The assistant does **not** persist anything; persistence of the final prompt (if the user generates) is handled by the existing image-generation history.
- Because the gate serializes GPU access, an in-flight assistant call and an in-flight image generation do not run concurrently; the assistant call holds the gate's GPU lease for its (short) duration.
- The feature is user-facing, so page copy is in English (consistent with `007-image-generate`); specs, plan, tasks, and code comments remain in English.
