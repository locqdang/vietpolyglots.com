# Contract: `POST /api/image/generate`

Feature: `007-image-generate`. Single authenticated endpoint that calls the GPU gate's Chroma API server-side and returns the image as a data URL.

## Endpoint

- **Method**: `POST`
- **Path**: `/api/image/generate`
- **Auth**: Session cookie (`vp_session`, JWT). No other auth accepted.
- **Request `Content-Type`**: `application/json`
- **Response `Content-Type`**: `application/json`
- **Config**: `GPU_GATE_URL` (env, default `http://192.168.0.62:8189`)

## Request body

```json
{
  "prompt": "A watercolor of a red dragon flying over a mountain at sunrise",
  "negativePrompt": "",
  "width": 512,
  "height": 512,
  "steps": 26,
  "cfg": 3.8,
  "seed": null
}
```

Only `prompt` is required. Omitted fields are not forwarded, so the gate applies its defaults. See [data-model.md](../data-model.md) → *Generation Request* for the full field table and validation/clamp rules.

## Responses

### `200` — success

```json
{
  "success": true,
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "promptId": "8f2c1a...",
  "seed": 1234567890
}
```

`image` is the gate's output bytes fetched from its relative `/view` URL, base64-encoded; content type inferred from the image filename extension (default `png`).

### `400` — validation error

```json
{ "success": false, "error": "Prompt is required." }
```

Returned when `prompt` is missing/whitespace/oversized, or a provided numeric field is out of the gate's accepted range (e.g. `width` not a multiple of 8). No gate call is made.

### `401` — unauthenticated

```json
{ "success": false, "error": "Unauthorized" }
```

Returned when there is no valid session. No gate call is made.

### `405` — wrong method

```json
{ "error": "Method not allowed" }
```

Returned for any method other than `POST`.

### `500` — generation failed

```json
{ "success": false, "error": "Image generation failed. Please try again." }
```

Returned when the gate responds `500` (`generation_failed`) or when the image fetch after a successful generate unexpectedly fails to yield an image.

### `502` — gate / ComfyUI unavailable

```json
{ "success": false, "error": "Image service is unavailable. Please try again." }
```

Returned when the gate is unreachable, or responds `502` (`comfy_rejected_prompt` / `comfy_unavailable`), or the image-bytes fetch fails.

### `504` — timeout

```json
{ "success": false, "error": "Image generation timed out. Please try again." }
```

Returned when the gate responds `504` (`generation_timeout`) or the app-side request to the gate exceeds its client-side timeout bound.

## Invariants (security / behavior)

- **I1**: The GPU gate (and ComfyUI) base URL (host:port) MUST NOT appear in any response body, header, or the page HTML/client JS. (FR-010, SC-005)
- **I2**: An unauthenticated request MUST return `401` without contacting the gate. (FR-005, SC-002)
- **I3**: A request with an empty/whitespace prompt MUST return `400` without contacting the gate. (FR-004, SC-003)
- **I4**: The server MUST stop waiting on the gate after the client-side timeout bound and return `504`. (SC-004)
- **I5**: The endpoint MUST log the request with `createApiLogger` (route, operation, hashed user identity) and MUST NOT log the raw user email. (FR-013)
- **I6**: The request body is parsed defensively; a malformed JSON body MUST return `400`, not crash the route.
- **I7**: The app MUST NOT build or submit a ComfyUI node graph; it MUST delegate generation entirely to the gate's `POST /api/chroma/generate`. (R0)

## Server → GPU gate internal flow (not a client contract)

1. `readSession(req)` → `401` if absent.
2. Validate + map the request via `buildChromaPayload(...)` → `400` if invalid.
3. `POST {GPU_GATE_URL}/api/chroma/generate` with the mapped payload (single blocking request; the gate waits for the render internally).
4. On success, read `images[0].url` (relative `/view?...`), `GET {GPU_GATE_URL}` + that path → image bytes.
5. Base64-encode → return in `image` data URL.

See [research.md](../research.md) R0–R3 for the gate contract and R5 for the base-URL configuration.
