import { createApiLogger } from '../../../../lib/api-logging';
import { readSession } from '../../../../lib/auth/session';
import {
  completeJob,
  getJobByOwner,
  getJobByPromptIdOwner,
} from '../../../../lib/image-generate/jobs';
import { getImageGenerationStatus } from '../../../../lib/image-generate/gate-client';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
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
  const promptId = typeof req.query?.promptId === 'string' ? req.query.promptId : '';
  if (!jobId || typeof jobId !== 'string') {
    return res.status(404).json({ error: 'Job not found' });
  }

  let job = promptId
    ? await getJobByPromptIdOwner(promptId, email)
    : await getJobByOwner(jobId, email);
  if (!job || job.jobId !== jobId) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Resumed clients use the gate prompt ID as the source of truth. This lets
  // progress survive a browser refresh or an interrupted worker poll.
  if (promptId && job.status !== 'completed') {
    try {
      const gateStatus = await getImageGenerationStatus(promptId);
      if (gateStatus.status === 'completed') {
        await completeJob(job.jobId, {
          ...gateStatus,
          seed: job.seed,
          promptId,
        });
        job = await getJobByOwner(job.jobId, email);
      } else if (gateStatus.status === 'queued' || gateStatus.status === 'processing') {
        // Never regress the stage: the stored status is already accurate (the
        // worker no longer flips it to "processing" early — it moves queued →
        // processing exactly when the gate accepts the prompt and returns a prompt
        // id, which is when the GPU is actually acquired). The live gate read can
        // briefly report a staler state (e.g. "queued" right after the prompt is
        // attached, before ComfyUI has recorded it), so keep the higher of the two
        // and only move forward. The reported percent is likewise the higher value.
        const statusRank = { queued: 1, processing: 2 };
        const nextStatus =
          (statusRank[job.status] ?? 0) >= (statusRank[gateStatus.status] ?? 0)
            ? job.status
            : gateStatus.status;
        const storedPercent = job.progress?.percent ?? 0;
        const gatePercent = gateStatus.status === 'processing' ? 60 : 20;
        job = {
          ...job,
          status: nextStatus,
          progress: {
            label: nextStatus === 'queued' ? 'Queued' : 'Generating',
            percent: Math.max(storedPercent, gatePercent),
          },
        };
      }
    } catch {
      // Keep the stored state available if the gate status probe is transiently unavailable.
    }
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
