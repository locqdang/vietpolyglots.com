// Pure, strict validator for the prompt assistant's model output.
//
// SECURITY MODEL (FR-008/009): the model's `content` is UNTRUSTED. This function
// accepts ONLY a conforming { prompt, negative_prompt } object (both strings,
// prompt non-empty, each within the max length, and NO unexpected keys). Anything
// else — non-JSON, missing/wrong-typed fields, extra keys, over-limit fields — is
// rejected with { ok: false, error } and the raw output is never surfaced. The
// only output that may reach the client is the validated { prompt, negativePrompt }
// pair, which is rendered as plain text (FR-010).
//
// OBSERVED MODEL QUIRK (research R3): the model sometimes wraps the JSON object in
// literal single quotes and may emit stray text around it. We tolerate that
// cosmetic wrapping (strip one outer quote pair / locate the {…} span) but stay
// STRICT on the resulting structure.
//
// Pure function: (rawContent, config) -> { ok, prompt?, negativePrompt?, error? }.

import { getPromptAssistantConfig } from './prompt-assistant-config';

// Strip exactly one matching outer quote pair (the observed '…' wrapper) and trim.
function stripOuterQuotes(value) {
  let text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

// Try to parse a JSON object out of `text`: first the whole string, then the span
// from the first '{' to the last '}' (tolerates stray leading/trailing prose).
function extractJsonObject(text) {
  try {
    const whole = JSON.parse(text);
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole;
  } catch {
    // fall through to span extraction
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const span = JSON.parse(text.slice(start, end + 1));
    if (span && typeof span === 'object' && !Array.isArray(span)) return span;
  } catch {
    return null;
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isString(value) {
  return typeof value === 'string';
}

/**
 * Validate raw model content into a prompt pair, or reject it.
 *
 * @param {unknown} rawContent the model's message content (untrusted)
 * @param {object} [config] optional config override (used by tests)
 * @returns {{ ok: boolean, prompt?: string, negativePrompt?: string, error?: string }}
 */
export function parsePromptAssistantResponse(rawContent, config = getPromptAssistantConfig()) {
  if (typeof rawContent !== 'string') {
    return { ok: false, error: 'invalid_model_response' };
  }

  const candidate = stripOuterQuotes(rawContent);
  const obj = extractJsonObject(candidate);
  if (!obj) {
    return { ok: false, error: 'invalid_model_response' };
  }

  // STRICT schema: exactly the two expected keys, correct types, bounded length.
  const allowedKeys = ['prompt', 'negative_prompt'];
  const presentKeys = Object.keys(obj);
  const hasExtra = presentKeys.some((key) => !allowedKeys.includes(key));
  if (hasExtra || !isString(obj.prompt) || !isString(obj.negative_prompt)) {
    return { ok: false, error: 'invalid_model_response' };
  }
  if (!isNonEmptyString(obj.prompt)) {
    return { ok: false, error: 'invalid_model_response' };
  }
  if (obj.prompt.length > config.maxPrompt || obj.negative_prompt.length > config.maxPrompt) {
    return { ok: false, error: 'invalid_model_response' };
  }

  return { ok: true, prompt: obj.prompt, negativePrompt: obj.negative_prompt };
}
