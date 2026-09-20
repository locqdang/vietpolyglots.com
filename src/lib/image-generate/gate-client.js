// Server-side GPU gate client. Never imported from client components.
// Calls the gate's Chroma API, fetches the produced image bytes, and returns
// them as a base64 data URL. The gate base URL is read from GPU_GATE_URL.

const DEFAULT_GATE_URL = 'http://192.168.0.62:8189';
const GATE_TIMEOUT_MS = 120_000;

export class GateError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'GateError';
    this.status = status;
    this.detail = detail;
  }
}

function gateUrl() {
  return (process.env.GPU_GATE_URL || DEFAULT_GATE_URL).replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = GATE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new GateError(504, 'Generation timed out — the GPU gate did not respond in time.');
    }
    throw new GateError(502, 'Unable to reach the GPU gate. Please try again later.');
  } finally {
    clearTimeout(timer);
  }
}

async function parseGateJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchImageDataUrl(baseUrl, imageUrl) {
  // imageUrl is relative, e.g. "/view?filename=x.png&subfolder=&type=output"
  const url = `${baseUrl}${imageUrl}`;
  const response = await fetchWithTimeout(url, {}, 10_000);
  if (!response.ok) {
    throw new GateError(502, 'Failed to fetch the generated image from the GPU gate.');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'image/png';
  const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
  return dataUrl;
}

export async function submitImageGeneration(payload) {
  const base = gateUrl();
  const response = await fetchWithTimeout(`${base}/api/chroma/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, async: true }),
  });
  const body = await parseGateJson(response);
  if (!response.ok || !body.prompt_id) {
    throw new GateError(response.status || 502, body.detail || 'Unable to submit image generation.');
  }
  return { promptId: body.prompt_id, seed: body.seed };
}

export async function getImageGenerationStatus(promptId) {
  const base = gateUrl();
  const response = await fetchWithTimeout(
    `${base}/api/chroma/status/${encodeURIComponent(promptId)}`,
    {},
    10_000
  );
  const body = await parseGateJson(response);
  if (!response.ok) {
    throw new GateError(response.status, body.detail || 'Unable to read generation progress.');
  }
  if (body.status !== 'success') {
    return { status: body.status, promptId: body.prompt_id || promptId };
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images[0]?.url) {
    throw new GateError(500, 'The GPU gate returned no image. Please try again.');
  }
  return {
    status: 'completed',
    promptId: body.prompt_id || promptId,
    image: await fetchImageDataUrl(base, images[0].url),
  };
}
