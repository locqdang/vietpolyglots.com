import { createApiLogger } from '../../../lib/api-logging';
import { readSession } from '../../../lib/auth/session';
import { logger, serializeError } from '../../../lib/logger';
import { buildChromaPayload } from '../../../lib/image-generate/payload';
import { createJob, failJob, removeFailedJobByOwner } from '../../../lib/image-generate/jobs';
import { enqueueGeneration } from '../../../lib/image-generate/queue';
import { checkImageGenerateRateLimit } from '../../../lib/image-generate/rate-limit';

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
  const email = normalizeEmail(session?.user?.email);
  if (!email) {
    baseLog.warn({ reason: 'missing_token' }, 'Image generate auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = createApiLogger(req, {
    route: '/api/image/generate',
    operation: 'image_generate',
    userEmail: email,
  });

  const request = req.body && typeof req.body === 'object' ? req.body : {};
  const replaceFailedJobId =
    typeof request.replace_failed_job_id === 'string'
      ? request.replace_failed_job_id.trim()
      : '';
  const { ok, payload, error } = buildChromaPayload(request);
  if (!ok) {
    log.warn({ reason: 'invalid_request' }, 'Image generate invalid request');
    return res.status(400).json({ error });
  }

  let rateLimit;
  try {
    rateLimit = await checkImageGenerateRateLimit(email);
  } catch (err) {
    logger.error({ error: serializeError(err) }, 'Image generate: rate limiter unavailable');
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
  }

  res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
  res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    log.warn({ reason: 'rate_limited' }, 'Image generate rate limit exceeded');
    return res.status(429).json({
      error: `You have reached the image generation limit. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  // The job id is the Mongo handle and the BullMQ job id (one value, two systems).
  const jobId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await createJob({
      jobId,
      userEmail: email,
      prompt: payload.prompt,
      negativePrompt: payload.negative_prompt ?? null,
      width: payload.width,
      height: payload.height,
    });
  } catch (err) {
    logger.error({ error: serializeError(err) }, 'Image generate: job store unavailable');
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
  }

  try {
    await enqueueGeneration({ jobId, payload });
  } catch (err) {
    logger.error({ error: serializeError(err) }, 'Image generate: enqueue failed');
    // The job is already recorded; mark it failed so polling does not hang on 'queued'.
    try {
      await failJob(jobId, { error: 'Service temporarily unavailable. Please try again later.' });
    } catch {}
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
  }

  if (replaceFailedJobId) {
    try {
      await removeFailedJobByOwner(replaceFailedJobId, email);
    } catch (err) {
      // The replacement is already queued. Keep both records rather than fail
      // a valid new request if cleanup is temporarily unavailable.
      logger.warn(
        { replaceFailedJobId, error: serializeError(err) },
        'Image generate: failed-record replacement cleanup unavailable'
      );
    }
  }

  log.info({ jobId }, 'Image generate: queued');
  return res.status(202).json({ jobId });
}
