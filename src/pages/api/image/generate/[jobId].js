import { createApiLogger } from '../../../../lib/api-logging';
import { readSession } from '../../../../lib/auth/session';
import { getJobByOwner } from '../../../../lib/image-generate/jobs';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * GET /api/image/generate/[jobId]
 * Returns the job's progress/result. Only the owning user can read it (404
 * otherwise, so a stranger learns nothing about another user's job).
 *
 * Response shape:
 *   200 { jobId, status, progress, image?, seed?, promptId?, error? }
 *   401 { error }            // not signed in
 *   404 { error }            // unknown id or not owned by the caller
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const log = createApiLogger(req, {
    route: '/api/image/generate/[jobId]',
    operation: 'image_generate_status',
  });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = readSession(req);
  const email = normalizeEmail(session?.user?.email);
  if (!email) {
    log.warn({ reason: 'missing_token' }, 'Image generate status auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const jobId = req.query?.jobId;
  if (!jobId || typeof jobId !== 'string') {
    return res.status(404).json({ error: 'Job not found' });
  }

  const job = await getJobByOwner(jobId, email);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const response = {
    jobId: job.jobId,
    promptId: job.promptId ?? null,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt ?? '',
    status: job.status,
    progress: job.progress ?? { label: job.status, percent: 0 },
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    expiresAt: job.expiresAt ?? null,
  };

  if (job.status === 'completed') {
    response.image = job.image;
    response.seed = job.seed;
  } else if (job.status === 'failed') {
    response.error = job.error || 'Image generation failed. Please try again.';
  }

  return res.status(200).json(response);
}
