// Server-side LLM gate client for the prompt assistant. Never imported from
// client components. POSTs the structured chat request to the gate's OpenAI-
// compatible /v1/chat/completions endpoint and returns the raw model content
// string (untrusted) for strict validation by the caller. Mirrors gate-client.js:
// base URL from config, AbortController timeout bound, GateError mapping.
//
// SECURITY: the gate URL, model id, and any API key live server-side only and
// never reach the client.

import { getPromptAssistantConfig } from './prompt-assistant-config';

export class PromptAssistantGateError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'PromptAssistantGateError';
    this.status = status;
    this.detail = detail;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new PromptAssistantGateError(504, 'Prompt generation timed out. Please try again.');
    }
    throw new PromptAssistantGateError(
      502,
      'Prompt generation service is temporarily unavailable. Please try again later.'
    );
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * Ask the LLM gate for a prompt + negative prompt for a validated request.
 *
 * @param {object} request the structured chat request from buildPromptAssistantRequest
 * @param {object} [config] optional config override (used by tests)
 * @returns {Promise<string>} the model's message content (raw, untrusted string)
 * @throws {PromptAssistantGateError} 502 (network/gate error) or 504 (timeout)
 */
export async function generatePromptPair(
  request,
  config = getPromptAssistantConfig(),
  requestId = ''
) {
  const base = config.gateUrl;
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (requestId) headers['X-GPU-Gate-Request-ID'] = requestId;

  const response = await fetchWithTimeout(
    `${base}/v1/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(request) },
    config.timeoutMs
  );
  const body = await parseJson(response);

  if (!response.ok) {
    throw new PromptAssistantGateError(
      response.status || 502,
      body.error?.message || 'Prompt generation service error. Please try again.'
    );
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new PromptAssistantGateError(502, 'Prompt generation returned an unexpected response.');
  }
  return content;
}
