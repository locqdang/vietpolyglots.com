import { createApiLogger } from '../../../lib/api-logging';
import { readSession } from '../../../lib/auth/session';
import { serializeError } from '../../../lib/logger';
import { buildChromaPayload } from '../../../lib/image-generate/payload';
import { generateImage, GateError } from '../../../lib/image-generate/gate-client';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const baseLog = createApiLogger(req, {
    route: '/api/image/generate',
    operation: 'image_generate',
  });

  if (req.method !== 'POST') {
    baseLog.warn({ method: req.method }, 'Image generate invalid method');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = readSession(req);
  if (!session?.user?.email) {
    baseLog.warn({ reason: 'missing_token' }, 'Image generate auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const email = normalizeEmail(session.user.email);
  if (!email) {
    baseLog.warn({ reason: 'invalid_token_payload' }, 'Image generate auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = createApiLogger(req, {
    route: '/api/image/generate',
    operation: 'image_generate',
    userEmail: email,
  });

  const request = req.body && typeof req.body === 'object' ? req.body : {};
  const { ok, payload, error } = buildChromaPayload(request);
  if (!ok) {
    log.warn({ reason: 'invalid_request' }, 'Image generate invalid request');
    return res.status(400).json({ error });
  }

  try {
    const result = await generateImage(payload);
    log.info({ promptId: result.promptId, seed: result.seed }, 'Image generate success');
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof GateError) {
      log.warn({ status: error.status, detail: error.detail }, 'Image generate gate error');
      return res.status(error.status).json({ error: error.message });
    }
    log.error({ error: serializeError(error) }, 'Image generate unexpected error');
    return res.status(502).json({ error: 'Image generation failed. Please try again later.' });
  }
}
