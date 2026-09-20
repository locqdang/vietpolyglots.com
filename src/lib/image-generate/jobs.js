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
const TTL_SECONDS = 24 * 60 * 60; // keep logs + results for one day

let indexReady = false;

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
        updatedAt: now(),
      },
    }
  );
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
  return col.findOne({ jobId, userEmail });
}
