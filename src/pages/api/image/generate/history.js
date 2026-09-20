import { createApiLogger } from '../../../../lib/api-logging';
import { readSession } from '../../../../lib/auth/session';
import { listJobsByOwner } from '../../../../lib/image-generate/jobs';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function requestedLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const log = createApiLogger(req, {
    route: '/api/image/generate/history',
    operation: 'image_generate_history',
  });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = normalizeEmail(readSession(req)?.user?.email);
  if (!email) {
    log.warn({ reason: 'missing_token' }, 'Image generate history auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit = requestedLimit(req.query?.limit);
  const jobs = await listJobsByOwner(email, { limit });
  return res.status(200).json({ jobs });
}
