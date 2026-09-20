import { createApiLogger } from '../../../../lib/api-logging';
import { readSession } from '../../../../lib/auth/session';
import { getRateLimitStatus } from '../../../../lib/image-generate/rate-limit';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/**
 * GET /api/image/generate/quota
 * Read-only, owner-scoped: the caller's current rate-limit usage for the live
 * quota display. Consumes no attempt. 503 when Redis is unavailable so the
 * client keeps its last-known value rather than showing a stale zero.
 *
 * Response:
 *   200 { limit, used, remaining, windowSeconds, resetsInSeconds }
 *   401 { error }   // not signed in
 *   503 { error }   // rate limiter unavailable
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const log = createApiLogger(req, {
    route: '/api/image/generate/quota',
    operation: 'image_generate_quota',
  });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = readSession(req);
  const email = normalizeEmail(session?.user?.email);
  if (!email) {
    log.warn({ reason: 'missing_token' }, 'Image generate quota auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const status = await getRateLimitStatus(email);
    return res.status(200).json(status);
  } catch (error) {
    log.warn({ reason: 'rate_limiter_unavailable' }, 'Image generate quota unavailable');
    return res.status(503).json({ error: 'Rate limit status is temporarily unavailable.' });
  }
}
