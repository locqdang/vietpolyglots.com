# Phase 0 Research: Image Generate Service

Feature: `007-image-generate`. Resolves every unknown raised in the spec/plan Technical Context.

## R0 — What "port 8189" actually is: the GPU gate (not ComfyUI directly)

**Finding**: Port `8189` is **not** a raw ComfyUI port. It is the **GPU gate** (`gpu-gate`), a Docker container on the LAN at `192.168.0.62:8189` (published as `0.0.0.0:8189->8189`). Per its README it is _"a GPU inference gate with VRAM handoff and a GPU lease mutex"_ and — decisively — _"All inference clients must use the gate ports. Do not connect to ComfyUI, SD.Next, or ComfyUI Manager ports directly from other apps."_

**Verified live** (from this host): `GET http://192.168.0.62:8189/ → 200`; `POST /api/chroma/generate {} → 400 {"error":"invalid_request","detail":"prompt is required and must be a non-empty string"}`. The endpoint is real and reachable without burning the GPU.

**Consequence**: The app is a **thin caller of the gate's high-level API**. It does **not** build a ComfyUI node graph, does **not** submit to `/prompt`, does **not** poll `/history`, and never learns the ComfyUI address. All of that is the gate's job. This replaces the original "talk to ComfyUI over its HTTP API" plan (former R1/R3) entirely.

## R1 — The gate's Chroma generation API (the contract we call)

**Decision**: Call `POST {GPU_GATE_URL}/api/chroma/generate`.

**Request** (all optional except `prompt` — confirmed in `gpu_gate.py: validate_chroma_request`):
| field | type | default | constraint |
|-------|------|---------|-----------|
| `prompt` | string | — | non-empty, ≤ 10000 chars |
| `negative_prompt` | string | gate default | ≤ 10000 chars |
| `width` | int | 512 | 256–2048, multiple of 8 |
| `height` | int | 512 | 256–2048, multiple of 8 |
| `steps` | int | 26 | 1–100 |
| `seed` | int | -1 (→ random) | -1 or 0 ≤ seed < 2^63 |
| `cfg` | number | 3.8 | 0–20 |
| `filename_prefix` | string | `Chroma1-HD/api` | relative, ≤ 128, no `..`/leading `/` |

**Success response** (`chroma_generate`, `gpu_gate.py:540`):

```json
{
  "status": "success",
  "prompt_id": "...",
  "seed": 123,
  "images": [
    {
      "filename": "...",
      "subfolder": "",
      "type": "output",
      "url": "/view?filename=...&subfolder=...&type=output"
    }
  ]
}
```

The `url` is **relative** (the gate intentionally keeps it relative so it works through either the direct LAN address or a reverse proxy). We resolve it against `GPU_GATE_URL` to fetch the bytes.

**Error responses** (the gate's own codes — we pass these through / map to the page):
| status | `error` | meaning |
|--------|---------|---------|
| 400 | `invalid_request` | bad/missing params |
| 500 | `generation_failed` | ComfyUI job completed in an error state |
| 502 | `comfy_rejected_prompt` / `comfy_unavailable` | ComfyUI rejected the prompt / unreachable |
| 504 | `generation_timeout` | the gate waited and the render did not finish |

**Rationale**: The gate is the sanctioned inference client and it already does the hard, GPU-unsafe parts (building the verified Chroma workflow from the bundled `chroma-api.json` template, enforcing the single-GPU lease, waiting for completion). Re-implementing any of that in the app would duplicate the gate, bypass its VRAM handoff, and risk corrupting other clients' renders — exactly what the gate exists to prevent.

## R2 — How to deliver the produced image to the browser

**Decision**: After `chroma/generate` returns, the API route fetches `GPU_GATE_URL + images[0].url` (the gate's `/view?...` bytes, e.g. PNG), base64-encodes them, and returns them in the JSON response as a data URL (`image: "data:image/<type>;base64,..."`). The page sets that string as an `<img>` `src`.

**Rationale**: The browser cannot reach `192.168.0.62:8189` (private LAN) in production, and the gate's `url` is relative, so the server must resolve and fetch the bytes. A data URL is the simplest stateless transport: no new static-asset route, no disk persistence (results are transient, v1), no extra URL the client must fetch. Response size is bounded by a single 512x512 image (well under ~2 MB base64). Content type is inferred from the gate's image `filename` extension (default `image/png`).

**Alternatives considered**:

- Return the gate's relative `url` and have the browser fetch it directly — leaks the internal gate host/port to the client and fails (private LAN + relative path), violates FR-010. Rejected.
- Persist to disk + serve via `/api/image/{id}` — adds storage and an id lifecycle; overkill for transient v1 results.
- Stream the image body directly with `image/png` content type — also valid, but a data URL keeps the single JSON response contract uniform (image + status + errors) and is trivially testable.

## R3 — The request-mapping helper (pure function)

**Decision**: A pure helper `buildChromaPayload({ prompt, negativePrompt?, width?, height?, steps?, cfg?, seed? })` produces the gate payload. It:

- trims and validates `prompt` (non-empty, ≤ 10000) — empty/oversized rejected before any HTTP call (FR-004, SC-003);
- passes through optional params **only when provided**, so the gate applies its own defaults otherwise;
- clamps/validates the optional numeric fields to the gate's ranges (width/height multiple of 8 in 256–2048, steps 1–100, cfg 0–20, seed -1 or 0..2^63-1) so we fail fast with a clean 400 instead of echoing the gate's.

**Rationale**: Pure and cheap to unit-test (the "test-first" target in the spec). Keeping mapping separate from the HTTP layer makes the integration test able to stub the gate and assert the exact payload. The app stays a thin, predictable caller.

**Note on "chroma"**: the user's model answer "chroma" is the gate's **Chroma API / Chroma1-HD pipeline** (CLIP `t5xxl_fp8_chroma_fixed.safetensors`, `type: "chroma"`), built and run by the gate. There is no model to choose in the app; the gate owns it. (This supersedes the earlier interpretation that wired a Flux Schnell graph in the app.)

## R4 — Authentication (unchanged)

**Decision**: Reuse the existing auth as-is.

- Page: add `'/services/image-generate'` to `privateRoutes` in `src/lib/auth.tsx`. The app is already wrapped in `<RequireAuth>` (via `Providers`), so this single list edit gives the client-side redirect to `/login?redirect=/services/image-generate`.
- API: call `readSession(req)` at the top of `src/pages/api/image/generate.js`; return `401` if no session. Defense-in-depth (the page gate is not the only lock).

**Rationale**: The JWT-in-HttpOnly-cookie session, `readSession`, `RequireAuth`, and `privateRoutes` are already used by `/video-meeting` and `/haro/**`. Reusing them avoids new auth code and matches the codebase.

**Alternatives considered**: Middleware-based route protection — the codebase intentionally uses the client `RequireAuth` allowlist (not edge middleware) for private routes, so adding middleware would diverge from the established pattern.

## R5 — Gate base URL / address (not localhost)

**Decision**: Read `GPU_GATE_URL` from environment, defaulting to `http://192.168.0.62:8189` (the gate's LAN address — the container is bound on `192.168.0.62`, so `localhost:8189` will **not** work and the earlier `localhost` default was wrong). Add it to `.env` and `.env.example`.

**Rationale**: Keeps the host/port out of code (FR-012) and lets the operator point the app at a different gate host (e.g. a reverse-proxy hostname) with a one-line env change. The default is the verified-live LAN address.

**Alternatives considered**: Hardcoding — rejected (violates FR-012). `localhost:8189` — rejected (the gate is not bound to loopback; confirmed `localhost:8189` refuses while `192.168.0.62:8189` answers).

## R6 — Parameter exposure

**Decision**: v1 form exposes the prompt plus optional negative prompt. The advanced numeric params (width, height, steps, cfg, seed) are accepted by the helper and API but not surfaced in the v1 form; they use the gate's defaults and can be added as an "advanced" panel later. No model selector — the gate owns the Chroma model.

**Rationale**: Matches the spec (advanced params optional for v1) and the gate's design (it owns the verified model). Fewer dials = fewer ways to produce a bad/ugly image by accident.

**Open items (none blocking)**: All NEEDS CLARIFICATION items are resolved. The only external dependency is the GPU gate being reachable on the configured host/port at runtime — documented as an environment precondition in `quickstart.md`.
