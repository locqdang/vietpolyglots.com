// BullMQ queue + in-process worker for image generation.
//
// Why in-process (not a separate service): this package is CommonJS-default, so a
// standalone `node worker.js` cannot import the app's ESM-style modules. Running the
// worker inside the Next server process avoids that and avoids a new compose service.
// The worker is started lazily and exactly once per process (idempotent guard).
//
// The queue is Redis-backed. REDIS_URL points at the LAN Redis (dedicated DB 1). The
// gate (GPU_GATE_URL) is still the only thing that talks to ComfyUI — the worker
// submits asynchronously (async: true, returns prompt_id immediately) and then polls
// the gate's status endpoint by prompt_id until the image is ready.

import { Queue, Worker } from 'bullmq';
import { logger, serializeError } from '../logger';
import { submitImageGeneration, getImageGenerationStatus, GateError } from './gate-client';
import { attachPromptId, completeJob, failJob } from './jobs';

const QUEUE_NAME = 'image-generate';

const DEFAULT_REDIS_URL = 'redis://192.168.0.62:6379/1';

function redisUrl() {
  return process.env.REDIS_URL || DEFAULT_REDIS_URL;
}

let queue = null;
let worker = null;

/**
 * Run one generation job: submit to the gate, persist the prompt id, then poll
 * the gate by prompt id until the image is ready (success) or it fails. The job
 * stays "queued" until the gate accepts the prompt and returns a prompt id — the
 * GPU wait happens inside the gate's submit, so marking it "processing" up front
 * would hide the real "waiting for the GPU" stage. Exported so tests can drive
 * it directly without a live Redis/worker.
 *
 * @param {{ jobId: string, payload: object }} jobData
 * @returns {Promise<object>} the gate result on success
 * @throws the original error on failure (so BullMQ records/retires the job)
 */
export async function processGenerationJob(jobData) {
  const { jobId, payload } = jobData;
  logger.info({ jobId, prompt: payload.prompt }, 'image-gen worker: starting (queued for GPU)');

  try {
    const submitted = await submitImageGeneration(payload);
    await attachPromptId(jobId, submitted);
    logger.info(
      { jobId, promptId: submitted.promptId, prompt: payload.prompt },
      'image-gen worker: submitted'
    );

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const status = await getImageGenerationStatus(submitted.promptId);
      if (status.status === 'completed') {
        const result = { ...status, seed: submitted.seed };
        await completeJob(jobId, result);
        logger.info(
          { jobId, promptId: submitted.promptId, seed: result.seed, prompt: payload.prompt },
          'image-gen worker: completed'
        );
        return result;
      }
      if (status.status === 'failed') {
        throw new GateError(500, 'Image generation failed. Please try again later.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new GateError(504, 'Generation timed out — the GPU gate did not respond in time.');
  } catch (error) {
    const message =
      error instanceof GateError
        ? error.message
        : 'Image generation failed. Please try again later.';
    logger.error(
      { jobId, prompt: payload.prompt, error: serializeError(error) },
      'image-gen worker: failed'
    );
    await failJob(jobId, { error: message });
    // Re-throw so BullMQ records the job as failed (and applies retry policy).
    throw error;
  }
}

/**
 * Lazily create (and cache) the BullMQ queue.
 */
export function getQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: { url: redisUrl() },
      defaultJobOptions: {
        // One retry on a transient gate failure, then fail. The gate blocks for a
        // long time, so keep the timeout generous.
        attempts: 2,
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 24 * 60 * 60 },
      },
    });
  }
  return queue;
}

/**
 * Start the in-process worker if it is not already running. Safe to call multiple
 * times (e.g. from several API routes) — it only starts once.
 */
export function ensureWorkerStarted() {
  if (worker) {
    return worker;
  }

  worker = new Worker(
    QUEUE_NAME,
    (job) => processGenerationJob(job.data),
    {
      connection: { url: redisUrl() },
      // One job at a time: the gate owns the GPU and only one render should run.
      concurrency: 1,
    }
  );

  worker.on('error', (error) => {
    logger.error({ error: serializeError(error) }, 'image-gen worker error');
  });
  worker.on('failed', (job, error) => {
    logger.warn({ jobId: job?.id, error: serializeError(error) }, 'image-gen job failed in queue');
  });

  return worker;
}

/**
 * Enqueue a validated payload for generation.
 * @param {{ jobId: string, payload: object }} item
 * @returns {Promise<{ jobId: string }>}
 */
export async function enqueueGeneration({ jobId, payload }) {
  ensureWorkerStarted();
  const job = await getQueue().add('generate', { jobId, payload }, { jobId });
  return { jobId: job.id ?? jobId };
}
