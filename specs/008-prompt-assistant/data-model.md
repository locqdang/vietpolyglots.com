# Data Model: Image Prompt Assistant

**Feature**: `008-prompt-assistant` | **Phase 1 output**

This feature is **non-persistent** by design (FR: the assistant only *drafts* a prompt). There are **no new database tables, collections, or migrations**. The "entities" below are the in-memory/transient shapes that cross the module boundaries, plus the one Redis-backed rate-limit counter (a key, not a schema).

---

## 1. Prompt Idea (transient input)

The user's short, free-text description.

| Field | Type | Constraint | Notes |
| --- | --- | --- | --- |
| `idea` | string | non-empty after trim; length ≤ `PROMPT_ASSISTANT_MAX_IDEA` (default 1000) | Treated strictly as **data** (never instructions). Bounded to bound the model call. |

- **Validation**: empty/whitespace → rejected (`400`). Oversized → rejected (`400`) **before** any model call.
- **Persistence**: none. Lives only for the request.

## 2. Assistant Chat Request (server → model)

The structured OpenAI-compatible `chat/completions` body. Built by the pure helper `buildPromptAssistantRequest(idea)`.

| Field | Type | Source | Notes |
| --- | --- | --- | --- |
| `model` | string | env `PROMPT_ASSISTANT_MODEL` | Fixed server-side; not user-influenceable. |
| `stream` | boolean | constant `false` | Non-streaming. |
| `response_format` | object | constant `{ type: "json_object" }` | Forces JSON output. |
| `messages` | array | **fixed** system message + one `user` message | The system message is a server constant. The `user` message contains **only** the (validated, trimmed) idea. **No user bytes in the system message.** |
| `max_tokens` (optional) | integer | bounded constant | Caps output length as a secondary bound. |

**Invariant (the injection defense)**: the idea appears **only** in `messages[i].content` where `role === 'user'`. The system message, model, destination, and `response_format` are independent of user input.

## 3. Assistant Response (model → server)

The raw model `content` string. It is **untrusted** and must be parsed/validated before use.

- **Observed shape** (live): a JSON object with keys `prompt` and `negative_prompt` (snake_case), **possibly wrapped in literal single quotes** and possibly with stray surrounding text.
- **Handling**: `parsePromptAssistantResponse` (R3) coerces/strips/locates/`JSON.parse`s, then enforces the exact schema.

## 4. Validated Prompt Pair (server → client)

The only shape that may leave the server. Produced by `parsePromptAssistantResponse`.

| Field | Type | Constraint | Notes |
| --- | --- | --- | --- |
| `prompt` | string | non-empty; length ≤ `PROMPT_ASSISTANT_MAX_PROMPT` (default 2000) | Refined positive prompt. Rendered as **plain text** in the "Describe your image" field. |
| `negativePrompt` | string | length ≤ `PROMPT_ASSISTANT_MAX_PROMPT` (default 2000); may be empty | Negative prompt. Rendered as **plain text** in the "Things to avoid" field. |

- **Schema rule**: the parsed object must contain **only** these (mapped) keys with the above types; any extra key, wrong type, empty `prompt`, or over-limit field → the whole response is **rejected** (not surfaced).
- **Rendering**: always as plain text in `<textarea>`/`value` props; never `dangerouslySetInnerHTML`, never markup/script.

## 5. Assistant Rate-Limit State (Redis key, transient counter)

A per-user counter, mirroring `007`'s design.

| Attribute | Value | Notes |
| --- | --- | --- |
| Key | `prompt-assistant:rate:<sha256(normalizedEmail)>` | Separate namespace from `image-generate:rate:*`. |
| Value | integer count for the current window | Incremented atomically (`INCR`), expired atomically (`PEXPIRE`). |
| Limit | `PROMPT_ASSISTANT_RATE_LIMIT_MAX` (default 30) | Env-configurable. |
| Window | `PROMPT_ASSISTANT_RATE_LIMIT_WINDOW_SECONDS` (default 3600) | Env-configurable. |
| Failure mode | **Fail closed** (503) if Redis unavailable | Protects the GPU lease. |

## Relationships / state

- `Prompt Idea` → `Assistant Chat Request` (1:1, via `buildPromptAssistantRequest`).
- `Assistant Response` → `Validated Prompt Pair` (1:1, via `parsePromptAssistantResponse`; **0:1 on rejection**).
- `Validated Prompt Pair` → pre-fills the two existing form fields (the existing `007` generation flow then handles the final, user-edited prompt; the assistant stores nothing).
- `Assistant Rate-Limit State` gates the request **before** the model call; each accepted or rate-limited attempt increments the counter.

## What is NOT persisted

- The short idea, the chat request, the raw model response, and the generated prompt pair are **all transient**.
- If the user subsequently generates an image (with the edited prompt), the **existing** `007` job/history persists that final prompt — this is out of scope for the assistant.
