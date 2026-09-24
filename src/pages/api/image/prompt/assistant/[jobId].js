import { createApiLogger } from '../../../../../lib/api-logging';
import { readSession } from '../../../../../lib/auth/session';
import { logger, serializeError } from '../../../../../lib/logger';
import {
  getPromptAssistantJob,
  promptAssistantOwnerId,
} from '../../../../../lib/image-generate/prompt-assistant-queue';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const log = createApiLogger(req, {
    route: '/api/image/prompt/assistant/[jobId]',
    operation: 'prompt_assistant_status',
  });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const email = String(readSession(req)?.user?.email || '')
    .trim()
    .toLowerCase();
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const jobId = typeof req.query?.jobId === 'string' ? req.query.jobId : '';
  if (!jobId) return res.status(404).json({ error: 'Job not found' });

  let job;
  try {
    job = await getPromptAssistantJob(jobId, promptAssistantOwnerId(email));
  } catch (error) {
    logger.error({ jobId, error: serializeError(error) }, 'Prompt assistant: status lookup failed');
    return res.status(503).json({
      error: 'Prompt status is temporarily unavailable. The queued job will continue processing.',
    });
  }
  if (!job) return res.status(404).json({ error: 'Job not found' });
  log.info({ jobId, status: job.status }, 'Prompt assistant job status');
  return res.status(200).json(job);
}
