// BullMQ queue + in-process worker for image generation.
//
// Why in-process (not a separate service): this package is CommonJS-default, so a
// standalone `node worker.js` cannot import the app's ESM-style modules. Running the
// worker inside the Next server process avoids that and avoids a new compose service.
// The worker is started lazily and exactly once per process (idempotent guard).
//
// The queue is Redis-backed. REDIS_URL points at the LAN Redis (dedicated DB 1). The
// gate (GPU_GATE_URL) is still the only thing that talks to ComfyUI — the worker
// merely calls the same generateImage() the old synchronous route used.

import { Queue, Worker } from 'bullmq';
import { logger, serializeError } from '../logger';
import { generateImage, GateError } from './gate-client';
import { markProcessing, completeJob, failJob } from './jobs';

const QUEUE_NAME = 'image-generate';

const DEFAULT_REDIS_URL = 'redis://192.168.0.62:6379/1';

function redisUrl() {
  return process.env.REDIS_URL || DEFAULT_REDIS_URL;
}

let queue = null;
let worker = null;

/**
 * Run one generation job: mark processing, call the gate, and persist the
 * outcome (image on success, user-safe error on failure). Exported so tests can
 * drive it directly without a live Redis/worker.
 *
 * @param {{ jobId: string, payload: object }} jobData
 * @returns {Promise<object>} the gate result on success
 * @throws the original error on failure (so BullMQ records/retires the job)
 */
export async function processGenerationJob(jobData) {
  const { jobId, payload } = jobData;
  logger.info({ jobId }, 'image-gen worker: processing');

  await markProcessing(jobId);

  try {
    const result = await generateImage(payload);
    await completeJob(jobId, result);
    logger.info({ jobId, promptId: result.promptId }, 'image-gen worker: completed');
    return result;
  } catch (error) {
    const message =
      error instanceof GateError
        ? error.message
        : 'Image generation failed. Please try again later.';
    logger.error({ jobId, error: serializeError(error) }, 'image-gen worker: failed');
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
