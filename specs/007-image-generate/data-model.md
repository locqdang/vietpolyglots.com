# Data Model: Image Generate Service

Feature: `007-image-generate`. v1 is **stateless** — no database entities, no persistence. The only "data" is a transient request → result pair. The app does **not** build a workflow; the GPU gate owns the Chroma workflow and returns output-image metadata.

## Entities

### 1. Generation Request (inbound, transient)

The payload the client POSTs to `/api/image/generate`. Numeric ranges mirror the gate's own `validate_chroma_request` so we fail fast with a clean `400` instead of echoing the gate's.

| Field            | Type   | Required | Validation / Clamp                                                           | Notes                                      |
| ---------------- | ------ | -------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `prompt`         | string | yes      | Trimmed; non-empty; length ≤ `MAX_PROMPT_LENGTH` (default 10000, = gate max) | Free-text description of the desired image |
| `negativePrompt` | string | no       | Trimmed; length ≤ 10000; omitted → gate default                              | Optional                                   |
| `width`          | int    | no       | 256–2048, **multiple of 8**; default 512                                     | Omitted → gate default                     |
| `height`         | int    | no       | 256–2048, **multiple of 8**; default 512                                     | Omitted → gate default                     |
| `steps`          | int    | no       | 1–100; default 26                                                            | Omitted → gate default                     |
| `cfg`            | number | no       | 0–20; default 3.8                                                            | Omitted → gate default                     |
| `seed`           | int    | no       | `-1` (random) or `0` ≤ seed < 2^63                                           | Omitted → gate random                      |

> v1 exposes only `prompt` (and optionally `negativePrompt`) in the UI. `width`, `height`, `steps`, `cfg`, `seed` are accepted by the helper/API for flexibility but are not surfaced in the form (spec: advanced params optional for v1).

**Validation rules**

- `prompt` empty/whitespace-only → reject with `400` (SC-003: never reaches the gate).
- `prompt` longer than `MAX_PROMPT_LENGTH` → `400`.
- Any provided numeric field out of the gate's range, or `width`/`height` not a multiple of 8 → `400` (do not silently coerce garbage).
- Optional fields that are omitted are **not** sent, so the gate applies its own defaults.

### 2. Generation Result (outbound, transient)

The JSON the API returns to the client on success.

| Field      | Type    | Notes                                                                                                                                            |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `success`  | boolean | `true`                                                                                                                                           |
| `image`    | string  | Data URL: `data:image/<ext>;base64,...` (the gate's `/view` image bytes, content type inferred from the image filename extension, default `png`) |
| `promptId` | string  | The gate's `prompt_id` (debugging / logging)                                                                                                     |
| `seed`     | number  | The gate's resolved `seed` (informational, lets a user re-run the same seed)                                                                     |

> No `model` field: the gate owns the Chroma model; the app does not know or expose it.

### 3. Error Result (outbound, transient)

Returned on any failure.

| Field     | Type    | Notes                                                       |
| --------- | ------- | ----------------------------------------------------------- |
| `success` | boolean | `false`                                                     |
| `error`   | string  | User-safe message (no raw stack, no gate/ComfyUI host/port) |

Error → HTTP status mapping:

- Missing/invalid session → `401`
- Invalid/missing/oversized prompt or out-of-range params → `400`
- Gate `500` (`generation_failed`), `502` (`comfy_rejected_prompt` / `comfy_unavailable`), or `504` (`generation_timeout`) → passed through as `500`/`502`/`504` respectively with a user-safe message
- App-level fetch of the gate's image bytes failed → `502`
- App-side request to the gate timed out (client-side abort) → `504`

### 4. Gate Output-Image Metadata (internal, never sent to client as a URL)

The `images[]` array the gate returns. We read `images[0].url` (a **relative** `/view?...` path), resolve it against `GPU_GATE_URL`, fetch the bytes server-side, and discard the metadata. The relative URL and the gate host are never serialized into the client response (FR-010, SC-005).

## Relationships

- One **Generation Request** → one gate `chroma/generate` call → one **Generation Result** (or one **Error Result**).
- No foreign keys, no persistence, no cross-request state. The gate enforces the single-GPU lease internally; the app holds no GPU state.

## State Transitions

```
idle → submitting (client in-flight, submit disabled) → success (image shown) | error (message shown) → idle (can re-submit)
```

The client disables the submit control while `submitting` to prevent duplicate generations (FR-008). The gate waits for the render internally (its own timeout), so the app is a single blocking request — there is no client-side polling loop.
