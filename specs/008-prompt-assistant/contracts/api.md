# API Contract: POST /api/image/prompt/assistant

**Feature**: `008-prompt-assistant` | **Phase 1 output**

A single new endpoint. It is the only interface this feature exposes to the browser, and the only place that talks to the LLM gate (server-side). It mirrors the `007-image-generate` API conventions (auth via `readSession`, Redis rate limit, structured logging, no host/secret leakage).

---

## Endpoint

`POST /api/image/prompt/assistant`

- **Content-Type**: `application/json`
- **Auth**: HttpOnly session cookie (`readSession`). Unauthenticated → `401`.
- **Method**: `POST` only; anything else → `405`.
- **Response headers**: `Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache`. On a rate-limited response, `Retry-After: <seconds>`.

## Request body

| Field | Type | Required | Constraint | Notes |
| --- | --- | --- | --- | --- |
| `idea` | string | yes | non-empty after trim; length ≤ `PROMPT_ASSISTANT_MAX_IDEA` (default 1000) | The short user idea. Treated strictly as data. |

Example:
```json
{ "idea": "a red fox in the snow" }
```

## Processing order (server)

1. Method check (`405`).
2. **Auth** via `readSession` → no email → `401`.
3. **Validate** `idea` (non-empty, length) → invalid → `400`.
4. **Rate limit** (Redis, separate assistant counter) → Redis down → `503` (fail closed); over limit → `429` + `Retry-After`.
5. **Build** the fixed chat request (`buildPromptAssistantRequest`).
6. **Call** the LLM gate (`POST {LLM_GATE_URL}/v1/chat/completions`) with a **timeout bound** → network/HTTP failure → `502`; timeout → `504`.
7. **Parse + validate** the model content (`parsePromptAssistantResponse`) → non-conforming → `422` (the invalid output is **not** returned).
8. **Respond** `200` with the validated pair.

## Responses

### `200 OK`
```json
{ "prompt": "A red fox standing in a snowy landscape, thick orange fur, ...", "negativePrompt": "blurry, low quality, deformed, extra limbs, watermark, text" }
```
- `prompt`: refined positive prompt (string, non-empty, ≤ `PROMPT_ASSISTANT_MAX_PROMPT`).
- `negativePrompt`: negative prompt (string, may be empty, ≤ `PROMPT_ASSISTANT_MAX_PROMPT`).

### `400 Bad Request`
```json
{ "error": "idea is required and must be a non-empty string" }
```
or `{ "error": "idea must not exceed 1000 characters" }`

### `401 Unauthorized`
```json
{ "error": "Unauthorized" }
```

### `422 Unprocessable Entity` (model returned non-conforming output)
```json
{ "error": "The assistant could not produce a usable prompt. Please try again or rephrase." }
```
- The raw/invalid model output is **never** included.

### `429 Too Many Requests`
Headers: `Retry-After: <seconds>`.
```json
{ "error": "You have reached the prompt assistant limit. Try again in 30 seconds.", "retryAfterSeconds": 30 }
```

### `502 Bad Gateway` (gate/model unreachable or HTTP error)
```json
{ "error": "The prompt assistant is temporarily unavailable. Please try again later." }
```

### `503 Service Unavailable` (rate limiter / Redis unavailable — fail closed)
```json
{ "error": "Service temporarily unavailable. Please try again later." }
```

### `504 Gateway Timeout` (model call exceeded the timeout bound)
```json
{ "error": "The assistant took too long to respond. Please try again." }
```

## Security invariants

- The model **base URL, host, port, and model id never appear** in any response body or header.
- The user's `idea` is placed **only** in the `user` message; the system instruction set, model, and destination are fixed server-side (FR-007).
- Only a **validated** `{ prompt, negativePrompt }` pair is ever returned (FR-008/009); anything else is a `422` with no output.
- The client renders the pair as **plain text** in form fields (FR-010).
- Logs carry only hashed user id + safe context, never raw email or the full idea/model output (FR-017).
