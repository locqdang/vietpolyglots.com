// Pure request-mapping + validation for the GPU gate's Chroma text-to-image API.
// Mirrors the gate's validate_chroma_request() constraints so we can reject bad
// input client-side before ever contacting the gate. Returns { ok, payload, error }.

const MAX_PROMPT = 10_000;
const MAX_NEGATIVE = 10_000;

// Default image size when the user does not choose one.
// Override via env (IMAGE_GEN_DEFAULT_WIDTH / IMAGE_GEN_DEFAULT_HEIGHT), e.g. in .env.
// Must be integers 256–2048 and multiples of 8 (gate constraint); falls back to 1024 if invalid.
function envDefault(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 256 && raw <= 2048 && raw % 8 === 0 ? raw : fallback;
}

const DEFAULT_WIDTH = envDefault('IMAGE_GEN_DEFAULT_WIDTH', 1024);
const DEFAULT_HEIGHT = envDefault('IMAGE_GEN_DEFAULT_HEIGHT', 1024);

/**
 * Default negative prompt, read at call time so tests can override the env
 * and the config endpoint can share the exact same source of truth.
 * Empty string when unset (i.e. no default negative prompt).
 */
export function getDefaultNegative() {
  const raw = process.env.IMAGE_GEN_DEFAULT_NEGATIVE;
  return typeof raw === 'string' ? raw : '';
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkDimension(name, value) {
  if (!isInt(value)) return `${name} must be an integer between 256 and 2048`;
  if (value < 256 || value > 2048) return `${name} must be an integer between 256 and 2048`;
  if (value % 8 !== 0) return `${name} must be a multiple of 8`;
  return null;
}

/**
 * Map a generation request (prompt + optional params) to a gate Chroma payload.
 *
 * @param {object} request
 * @param {string} [request.prompt]
 * @param {string} [request.negative_prompt]
 * @param {number} [request.width]
 * @param {number} [request.height]
 * @param {number} [request.steps]
 * @param {number} [request.seed]
 * @param {number} [request.cfg]
 * @returns {{ ok: boolean, payload?: object, error?: string }}
 */
export function buildChromaPayload(request) {
  const values = request && typeof request === 'object' ? request : {};

  const prompt = values.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt is required and must be a non-empty string' };
  }
  if (prompt.length > MAX_PROMPT) {
    return { ok: false, error: 'prompt must not exceed 10000 characters' };
  }

  const payload = { prompt: prompt.trim() };

  // Negative prompt: if the user omits it, fall back to the configured default
  // (may be empty). An explicit value — including "" (user cleared the default)
  // — is used as-is.
  if (values.negative_prompt === undefined) {
    const defaultNegative = getDefaultNegative();
    if (defaultNegative.length > 0) {
      payload.negative_prompt = defaultNegative;
    }
  } else {
    if (
      typeof values.negative_prompt !== 'string' ||
      values.negative_prompt.length > MAX_NEGATIVE
    ) {
      return { ok: false, error: 'negative_prompt must be a string of at most 10000 characters' };
    }
    payload.negative_prompt = values.negative_prompt;
  }

  if (values.width !== undefined) {
    const err = checkDimension('width', values.width);
    if (err) return { ok: false, error: err };
    payload.width = values.width;
  } else {
    payload.width = DEFAULT_WIDTH;
  }

  if (values.height !== undefined) {
    const err = checkDimension('height', values.height);
    if (err) return { ok: false, error: err };
    payload.height = values.height;
  } else {
    payload.height = DEFAULT_HEIGHT;
  }

  if (values.steps !== undefined) {
    if (!isInt(values.steps) || values.steps < 1 || values.steps > 100) {
      return { ok: false, error: 'steps must be an integer between 1 and 100' };
    }
    payload.steps = values.steps;
  }

  if (values.seed !== undefined) {
    if (!isInt(values.seed) || values.seed < -1 || values.seed >= 2 ** 63) {
      return { ok: false, error: 'seed must be an integer from -1 through 9223372036854775807' };
    }
    payload.seed = values.seed;
  }

  if (values.cfg !== undefined) {
    if (!isNumber(values.cfg) || values.cfg < 0 || values.cfg > 20) {
      return { ok: false, error: 'cfg must be a number between 0 and 20' };
    }
    payload.cfg = values.cfg;
  }

  return { ok: true, payload };
}
