import crypto from 'crypto';
import { Queue, Worker } from 'bullmq';
import { logger, serializeError } from '../logger';
import { getPromptAssistantConfig } from './prompt-assistant-config';
import { generatePromptPair, PromptAssistantGateError } from './prompt-assistant-gate';
import { parsePromptAssistantResponse } from './prompt-assistant-response';

// Queue name is namespaced by environment so the dev server and the production
// container NEVER drain the same BullMQ queue. Both default to the same Redis,
// so sharing one queue name lets the two workers steal each other's jobs — the
// stale production worker then executes a dev job it can't track (no gate-stage
// progress), leaving the dev UI stuck. Branching on NODE_ENV mirrors
// defaultLlmGateUrl() and isolates dev without any env wiring.
function queueName() {
  const override = process.env.PROMPT_ASSISTANT_QUEUE_NAME;
  if (override) return override;
  return process.env.NODE_ENV === 'production' ? 'prompt-assistant' : 'prompt-assistant-dev';
}

const QUEUE_NAME = queueName();
const DEFAULT_REDIS_URL = 'redis://192.168.0.62:6379/1';
let queue;
let worker;

// Unique gate request id per *attempt*. The gate keeps the request alive (and
// finishes it) even after our HTTP abort, so reusing the same id across retries
// would let a timed-out attempt's late result or a still-queued duplicate
// collide with the fresh attempt. One id per attempt keeps each gate request
// independent; ids are alphanumeric + underscores, which the gate accepts.
export function promptAssistantGateRequestId(job) {
  const attempt = Number(job.attemptsMade) || 0;
  const base = String(job.id).replace(/[^A-Za-z0-9_-]/g, '');
  return attempt > 0 ? `${base}-a${attempt}` : base;
}

function connection() {
  return { url: process.env.REDIS_URL || DEFAULT_REDIS_URL };
}

export function promptAssistantOwnerId(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

const GATE_STATUS_POLL_MS = 1_000;
// Maps the gate's per-request state (see GPU gate README) to a public UI
// status. `admitted` means the cohort is acquired and the VRAM handoff is
// done (the GPU is ready), so it is already in the "processing" bucket — the
// next transition is `forwarded`. On the join-existing-cohort path there is no
// `preparing_gpu` state at all (received -> waiting_for_gpu -> admitted ->
// forwarded), so folding `admitted` into `processing` keeps the join path
// correct without a spurious "Preparing model…" flash.
const GATE_STAGE_TO_PUBLIC_STATUS = {
  received: 'queued',
  waiting_for_gpu: 'waiting_for_gpu',
  preparing_gpu: 'preparing_gpu',
  admitted: 'processing',
  forwarded: 'processing',
};

async function readGateStage(requestId) {
  const { gateUrl } = getPromptAssistantConfig();
  try {
    const response = await fetch(`${gateUrl}/_gpu_gate/requests/${encodeURIComponent(requestId)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return '';
    const body = await response.json();
    return typeof body?.state === 'string' ? body.state : '';
  } catch {
    // Status tracking is supplemental. The inference request itself remains the
    // authoritative success/failure path and must not fail because polling did.
    return '';
  }
}

export async function processPromptAssistantJob(job) {
  // One gate request id per attempt, not per job: the gate keys its per-request
  // state machine to this id, so reusing the same id across a BullMQ retry would
  // have the status poller read the *previous* attempt's (already expired or
  // terminal) record and the gate collide with the prior attempt's in-flight
  // request. A fresh id per attempt keeps each attempt's gate state independent.
  const requestId = promptAssistantGateRequestId(job);
  let stopped = false;
  const trackGateStage = async () => {
    if (stopped) return;
    try {
      const gateStage = await readGateStage(requestId);
      if (gateStage && !stopped) await job.updateProgress({ gateStage });
    } catch (error) {
      logger.warn(
        { jobId: requestId, error: serializeError(error) },
        'prompt-assistant gate status update failed'
      );
    }
  };
  const timer = setInterval(() => void trackGateStage(), GATE_STATUS_POLL_MS);
  try {
    const raw = await generatePromptPair(job.data.chatRequest, undefined, requestId);
    const parsed = parsePromptAssistantResponse(raw);
    if (!parsed.ok) {
      throw new PromptAssistantGateError(
        422,
        'The assistant could not produce a usable prompt. Please try again.'
      );
    }
    return { prompt: parsed.prompt, negativePrompt: parsed.negativePrompt };
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

export function getPromptAssistantQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: connection(),
      defaultJobOptions: {
        attempts: 20,
        backoff: { type: 'fixed', delay: 15_000 },
        removeOnComplete: { age: 60 * 60 },
        removeOnFail: { age: 60 * 60 },
      },
    });
  }
  return queue;
}

export function ensurePromptAssistantWorkerStarted() {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, (job) => processPromptAssistantJob(job), {
    connection: connection(),
    concurrency: 1,
  });
  worker.on('error', (error) =>
    logger.error({ error: serializeError(error) }, 'prompt-assistant worker error')
  );
  worker.on('failed', (job, error) =>
    logger.warn(
      { jobId: job?.id, error: serializeError(error) },
      'prompt-assistant queued job attempt failed'
    )
  );
  return worker;
}

export async function enqueuePromptAssistant({ jobId, ownerId, chatRequest }) {
  ensurePromptAssistantWorkerStarted();
  const job = await getPromptAssistantQueue().add(
    'generate-prompt',
    { ownerId, chatRequest },
    { jobId }
  );
  return { jobId: job.id || jobId };
}

export function publicPromptAssistantStatus(state, attemptsMade = 0, gateStage = '') {
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'active') return GATE_STAGE_TO_PUBLIC_STATUS[gateStage] || 'starting';
  // BullMQ moves a transiently failed job into `delayed` during backoff. Calling
  // that state merely "queued" hides the fact that an attempt already failed.
  if (state === 'delayed' && attemptsMade > 0) return 'retrying';
  return 'queued';
}

export async function getPromptAssistantJob(jobId, ownerId) {
  const job = await getPromptAssistantQueue().getJob(jobId);
  if (!job || job.data?.ownerId !== ownerId) return null;
  const state = await job.getState();
  const gateStage =
    job.progress && typeof job.progress === 'object' ? String(job.progress.gateStage || '') : '';
  const status = publicPromptAssistantStatus(state, job.attemptsMade, gateStage);
  const attemptsMade = Number(job.attemptsMade) || 0;
  const attemptsMax = Number(job.opts?.attempts) || 1;

  if (status === 'completed') {
    return { jobId, status, attemptsMade, attemptsMax, ...job.returnvalue };
  }
  if (status === 'failed') {
    return {
      jobId,
      status,
      attemptsMade,
      attemptsMax,
      error: job.failedReason || 'Prompt generation failed. Please try again.',
    };
  }
  return { jobId, status, attemptsMade, attemptsMax };
}
