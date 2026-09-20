import { describe, it, expect, vi, beforeEach } from 'vitest';
import statusHandler from '../../pages/api/image/generate/[jobId]';
import configHandler from '../../pages/api/image/generate/config';
import { readSession } from '../../lib/auth/session';
import { getJobByOwner, getJobByPromptIdOwner, completeJob } from '../../lib/image-generate/jobs';
import { getImageGenerationStatus } from '../../lib/image-generate/gate-client';

vi.mock('../../lib/auth/session', () => ({
  readSession: vi.fn(),
}));

vi.mock('../../lib/image-generate/jobs', () => ({
  getJobByOwner: vi.fn(),
  getJobByPromptIdOwner: vi.fn(),
  completeJob: vi.fn(),
}));

vi.mock('../../lib/image-generate/gate-client', () => ({
  getImageGenerationStatus: vi.fn(),
}));

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const AUTHED = { user: { id: 'u1', email: 'loc@dang.com', name: 'Lockie' } };

describe('GET /api/image/generate/[jobId] integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 405 for non-GET', async () => {
    const res = createMockRes();
    await statusHandler({ method: 'POST', query: { jobId: 'x' } }, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 without a session', async () => {
    readSession.mockReturnValue(null);
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'x' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the job is not owned by the caller (or missing)', async () => {
    readSession.mockReturnValue(AUTHED);
    getJobByOwner.mockResolvedValue(null);
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'someone-else' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns the completed result with image + seed for the owner', async () => {
    readSession.mockReturnValue(AUTHED);
    getJobByOwner.mockResolvedValue({
      jobId: 'img_1',
      status: 'completed',
      progress: { label: 'Done', percent: 100 },
      image: 'data:image/png;base64,AAAA',
      seed: 42,
      promptId: 'p-1',
    });
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'img_1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.image).toBe('data:image/png;base64,AAAA');
    expect(res.body.seed).toBe(42);
  });

  it('returns progress for an in-flight job (no image yet)', async () => {
    readSession.mockReturnValue(AUTHED);
    getJobByOwner.mockResolvedValue({
      jobId: 'img_1',
      status: 'processing',
      progress: { label: 'Generating', percent: 50 },
    });
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'img_1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(res.body.image).toBeUndefined();
  });

  it('uses promptId to resume live progress for the owning job', async () => {
    readSession.mockReturnValue(AUTHED);
    getJobByPromptIdOwner.mockResolvedValue({
      jobId: 'img_1',
      promptId: 'p-1',
      status: 'failed',
      seed: 42,
    });
    getImageGenerationStatus.mockResolvedValue({ status: 'processing', promptId: 'p-1' });
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'img_1', promptId: 'p-1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(getImageGenerationStatus).toHaveBeenCalledWith('p-1');
    expect(res.body.status).toBe('processing');
    expect(res.body.promptId).toBe('p-1');
  });

  it('never regresses progress when the gate reports a staler state', async () => {
    readSession.mockReturnValue(AUTHED);
    // Stored job is already generating at 50%, but the gate still shows "queued"
    // (ComfyUI has not picked the prompt up yet). The response must not drop.
    getJobByPromptIdOwner.mockResolvedValue({
      jobId: 'img_1',
      promptId: 'p-1',
      status: 'processing',
      progress: { label: 'Generating', percent: 50 },
    });
    getImageGenerationStatus.mockResolvedValue({ status: 'queued', promptId: 'p-1' });
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'img_1', promptId: 'p-1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(res.body.progress.percent).toBe(50);
  });

  it('never reports a percent below the stored one for a live gate status', async () => {
    readSession.mockReturnValue(AUTHED);
    getJobByPromptIdOwner.mockResolvedValue({
      jobId: 'img_1',
      promptId: 'p-1',
      status: 'queued',
      progress: { label: 'Queued', percent: 20 },
    });
    getImageGenerationStatus.mockResolvedValue({ status: 'processing', promptId: 'p-1' });
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'img_1', promptId: 'p-1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(res.body.progress.percent).toBe(60);
  });

  it('returns the error for a failed job', async () => {
    readSession.mockReturnValue(AUTHED);
    getJobByOwner.mockResolvedValue({
      jobId: 'img_1',
      status: 'failed',
      progress: { label: 'Failed', percent: 100 },
      error: 'Generation timed out.',
    });
    const res = createMockRes();
    await statusHandler({ method: 'GET', query: { jobId: 'img_1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toMatch(/timed out/);
  });
});

describe('GET /api/image/generate/config', () => {
  it('returns the default negative prompt and size', async () => {
    const original = process.env.IMAGE_GEN_DEFAULT_NEGATIVE;
    process.env.IMAGE_GEN_DEFAULT_NEGATIVE = 'blurry, watermark';
    const res = createMockRes();
    await configHandler({ method: 'GET' }, res);
    if (original === undefined) delete process.env.IMAGE_GEN_DEFAULT_NEGATIVE;
    else process.env.IMAGE_GEN_DEFAULT_NEGATIVE = original;

    expect(res.statusCode).toBe(200);
    expect(res.body.defaultNegative).toBe('blurry, watermark');
    expect(res.body.defaultWidth).toBe(1024);
    expect(res.body.defaultHeight).toBe(1024);
  });

  it('returns 405 for non-GET', async () => {
    const res = createMockRes();
    await configHandler({ method: 'POST' }, res);
    expect(res.statusCode).toBe(405);
  });
});
