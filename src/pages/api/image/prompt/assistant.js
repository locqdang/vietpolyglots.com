import { createApiLogger } from '../../../../lib/api-logging';
import { readSession } from '../../../../lib/auth/session';
import { logger, serializeError } from '../../../../lib/logger';
import { buildPromptAssistantRequest } from '../../../../lib/image-generate/prompt-assistant-request';
import {
  enqueuePromptAssistant,
  promptAssistantOwnerId,
} from '../../../../lib/image-generate/prompt-assistant-queue';
import { checkPromptAssistantRateLimit } from '../../../../lib/image-generate/prompt-assistant-rate-limit';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const baseLog = createApiLogger(req, {
    route: '/api/image/prompt/assistant',
    operation: 'prompt_assistant',
  });

  if (req.method !== 'POST') {
    baseLog.warn({ method: req.method }, 'Prompt assistant invalid method');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth first (FR-002): nothing else runs without a valid session.
  const session = readSession(req);
  const email = normalizeEmail(session?.user?.email);
  if (!email) {
    baseLog.warn({ reason: 'missing_token' }, 'Prompt assistant auth failure');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = createApiLogger(req, {
    route: '/api/image/prompt/assistant',
    operation: 'prompt_assistant',
    userEmail: email,
  });

  const request = req.body && typeof req.body === 'object' ? req.body : {};
  const { ok, request: chatRequest, error } = buildPromptAssistantRequest(request.idea);
  if (!ok) {
    log.warn({ reason: 'invalid_request' }, 'Prompt assistant invalid request');
    return res.status(400).json({ error });
  }

  // Rate limit (FR-015): a tighter, separate limit than image generation.
  let rateLimit;
  try {
    rateLimit = await checkPromptAssistantRateLimit(email);
  } catch (err) {
    logger.error({ error: serializeError(err) }, 'Prompt assistant: rate limiter unavailable');
    return res
      .status(503)
      .json({ error: 'Service temporarily unavailable. Please try again later.' });
  }

  res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
  res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    log.warn({ reason: 'rate_limited' }, 'Prompt assistant rate limit exceeded');
    return res.status(429).json({
      error: `You have reached the prompt assistant limit. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  const jobId = `prompt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await enqueuePromptAssistant({
      jobId,
      ownerId: promptAssistantOwnerId(email),
      chatRequest,
    });
  } catch (err) {
    logger.error({ error: serializeError(err) }, 'Prompt assistant: enqueue failed');
    return res
      .status(503)
      .json({ error: 'Prompt queue is temporarily unavailable. Please try again.' });
  }

  log.info({ jobId }, 'Prompt assistant: queued');
  return res.status(202).json({ jobId, status: 'queued' });
}
