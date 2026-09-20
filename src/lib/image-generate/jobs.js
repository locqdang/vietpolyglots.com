// MongoDB store for image generation jobs.
//
// One document per generation attempt. It serves two purposes:
//   1. The prompt log — the user's prompt (and the negative prompt actually
//      used) are persisted for record-keeping.
//   2. The progress source of truth — a status field the client polls so it
//      can show queued → processing → completed/failed.
//
// The image result is stored as a base64 data URL so the page can display it
// without a second fetch. Documents carry a 24h TTL so old images do not grow
// the collection indefinitely.

import { getCollection } from '../data/mongodb';
import { logger, serializeError } from '../logger';

const COLLECTION = 'image_generate_jobs';
const HISTORY_COLLECTION = 'image_generate_history';
const TTL_SECONDS = 24 * 60 * 60; // transient queue/progress records
const DEFAULT_RETENTION_DAYS = 30;

let indexReady = false;
let historyIndexReady = false;

function retentionDays() {
  const parsed = Number.parseInt(String(process.env.IMAGE_GEN_RETENTION_DAYS || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

async function historyCollection() {
  const col = await getCollection(HISTORY_COLLECTION);
  if (!historyIndexReady) {
    try {
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await col.createIndex({ userEmail: 1, createdAt: -1 });
      await col.createIndex({ promptId: 1, userEmail: 1 });
    } catch (error) {
      logger.warn({ error: serializeError(error) }, 'image-gen history index create failed');
    }
    historyIndexReady = true;
  }
  return col;
}

async function collection() {
  const col = await getCollection(COLLECTION);
  if (!indexReady) {
    try {
      await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    } catch (error) {
      // Index creation is best-effort; a race between concurrent bootstraps is fine.
      logger.warn({ error: serializeError(error) }, 'image-gen job TTL index create failed');
    }
    indexReady = true;
  }
  return col;
}

function now() {
  return new Date();
}

/**
 * Create a queued job.
 * @returns {Promise<{ jobId: string }>}
 */
export async function createJob({ jobId, userEmail, prompt, negativePrompt, width, height }) {
  const col = await collection();
  const ts = now();
  await col.insertOne({
    jobId,
    userEmail,
    prompt,
    negativePrompt: negativePrompt ?? null,
    width: width ?? null,
    height: height ?? null,
    status: 'queued',
    progress: { label: 'Queued', percent: 0 },
    image: null,
    seed: null,
    promptId: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return { jobId };
}

/**
 * Move a job to processing (the worker picked it up).
 */
export async function markProcessing(jobId) {
  const col = await collection();
  await col.updateOne(
    { jobId },
    { $set: { status: 'processing', progress: { label: 'Generating', percent: 50 }, updatedAt: now() } }
  );
}

/**
 * Mark a job completed with its image result.
 */
export async function completeJob(jobId, { image, seed, promptId }) {
  const col = await collection();
  const completedAt = now();
  await col.updateOne(
    { jobId },
    {
      $set: {
        status: 'completed',
        progress: { label: 'Done', percent: 100 },
        image,
        seed: seed ?? null,
        promptId: promptId ?? null,
        error: null,
        updatedAt: completedAt,
      },
    }
  );

  // Copy completed results to a longer-lived, owner-scoped history collection.
  // The transient queue document still expires after 24 hours.
  const job = await col.findOne({ jobId });
  if (job) {
    try {
      const history = await historyCollection();
      const expiresAt = new Date(
        completedAt.getTime() + retentionDays() * 24 * 60 * 60 * 1000
      );
      await history.updateOne(
        { jobId },
        {
          $set: {
            jobId,
            userEmail: job.userEmail,
            prompt: job.prompt,
            negativePrompt: job.negativePrompt ?? null,
            width: job.width ?? null,
            height: job.height ?? null,
            status: 'completed',
            progress: { label: 'Done', percent: 100 },
            image,
            seed: seed ?? null,
            promptId: promptId ?? null,
            error: null,
            createdAt: job.createdAt ?? completedAt,
            updatedAt: completedAt,
            expiresAt,
          },
        },
        { upsert: true }
      );
    } catch (error) {
      // The generation itself succeeded. Do not mark it failed merely because
      // the longer-lived history copy could not be written.
      logger.error(
        { jobId, error: serializeError(error) },
        'image-gen completed but history persistence failed'
      );
    }
  }
}

/**
 * Mark a job failed with a user-safe error message.
 */
export async function failJob(jobId, { error }) {
  const col = await collection();
  await col.updateOne(
    { jobId },
    {
      $set: {
        status: 'failed',
        progress: { label: 'Failed', percent: 100 },
        error,
        image: null,
        updatedAt: now(),
      },
    }
  );
}

/**
 * Fetch a job by id, returning null if it does not exist.
 */
export async function getJob(jobId) {
  const col = await collection();
  return col.findOne({ jobId });
}

/**
 * Fetch a job only if it belongs to the given user (ownership guard).
 * Returns null for a missing job or a job owned by someone else so the API can
 * answer 404 without leaking whether another user's job exists.
 */
export async function getJobByOwner(jobId, userEmail) {
  const col = await collection();
  const active = await col.findOne({ jobId, userEmail });
  if (active) return active;

  const history = await historyCollection();
  return history.findOne({ jobId, userEmail });
}

/**
 * Return recent owner-scoped jobs without large image payloads. Active jobs and
 * retained completed jobs are merged and deduplicated by jobId.
 */
export async function listJobsByOwner(userEmail, { limit = 20 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const projection = {
    _id: 0,
    jobId: 1,
    promptId: 1,
    prompt: 1,
    negativePrompt: 1,
    status: 1,
    seed: 1,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 1,
  };
  const col = await collection();
  const history = await historyCollection();
  const [activeJobs, retainedJobs] = await Promise.all([
    col.find({ userEmail }).project(projection).sort({ createdAt: -1 }).limit(safeLimit).toArray(),
    history
      .find({ userEmail })
      .project(projection)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .toArray(),
  ]);

  const jobs = new Map();
  for (const job of [...retainedJobs, ...activeJobs]) jobs.set(job.jobId, job);
  return [...jobs.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, safeLimit);
}
