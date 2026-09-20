import { createApiLogger } from '../../../../lib/api-logging';
import { readSession } from '../../../../lib/auth/session';
import { listJobsByOwner } from '../../../../lib/image-generate/jobs';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function requestedLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) ? Math.min(50, Math.max(1, parsed)) : 12;
}

function requestedPage(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, parsed) : 1;
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
  const page = requestedPage(req.query?.page);
  const offset = (page - 1) * limit;
  const {
    jobs,
    total,
    limit: appliedLimit,
    offset: appliedOffset,
  } = await listJobsByOwner(email, {
    limit,
    offset,
  });
  const totalPages = Math.max(1, Math.ceil(total / appliedLimit));
  return res.status(200).json({
    jobs,
    total,
    limit: appliedLimit,
    offset: appliedOffset,
    page: appliedOffset / appliedLimit + 1,
    totalPages,
  });
}
