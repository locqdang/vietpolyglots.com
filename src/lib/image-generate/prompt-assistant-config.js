// Server-side configuration for the prompt assistant. Centralizes the env-driven
// knobs (gate URL, model id, timeout, rate-limit limits, and length bounds) with
// safe defaults so the feature works out-of-the-box on this host and can be tuned
// without code edits. Values are read at call time so tests can override the env.
// This module is server-only and never imported from client components.

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Development runs on the host, where Docker's `gpu-gate` DNS name does not
// resolve; production runs inside Compose on the gate's private network. An
// explicit LLM_GATE_URL always wins for other topologies.
function defaultLlmGateUrl() {
  return process.env.NODE_ENV === 'production' ? 'http://gpu-gate:8081' : 'http://127.0.0.1:8081';
}

export function getPromptAssistantConfig() {
  return {
    gateUrl: (process.env.LLM_GATE_URL || defaultLlmGateUrl()).replace(/\/+$/, ''),
    model: process.env.PROMPT_ASSISTANT_MODEL || 'Qwen3.8-27B-Uncensored-MTP-Q5_K_P',
    // Qwen can take more than 90 seconds to cold-load after another GPU workload.
    // Keep each queued attempt below the browser's 10-minute polling deadline while
    // giving the gate enough time to acquire the GPU and finish one completion.
    timeoutMs: positiveIntegerMs(process.env.PROMPT_ASSISTANT_TIMEOUT_MS, 300_000),
    rateLimitMax: positiveInteger(process.env.PROMPT_ASSISTANT_RATE_LIMIT_MAX, 30),
    rateLimitWindowSeconds: positiveInteger(
      process.env.PROMPT_ASSISTANT_RATE_LIMIT_WINDOW_SECONDS,
      3600
    ),
    maxIdea: positiveInteger(process.env.PROMPT_ASSISTANT_MAX_IDEA, 1000),
    maxPrompt: positiveInteger(process.env.PROMPT_ASSISTANT_MAX_PROMPT, 2000),
    // Optional server-side key; sent only if the gate requires it. Never exposed
    // to the client.
    apiKey: typeof process.env.LLM_GATE_API_KEY === 'string' ? process.env.LLM_GATE_API_KEY : '',
  };
}
