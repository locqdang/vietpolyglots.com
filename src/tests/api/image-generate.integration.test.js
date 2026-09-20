import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from '../../pages/api/image/generate';
import { readSession } from '../../lib/auth/session';
import { createJob, failJob } from '../../lib/image-generate/jobs';
import { enqueueGeneration } from '../../lib/image-generate/queue';
import { checkImageGenerateRateLimit } from '../../lib/image-generate/rate-limit';

vi.mock('../../lib/auth/session', () => ({
  readSession: vi.fn(),
}));

vi.mock('../../lib/image-generate/jobs', () => ({
  createJob: vi.fn(),
  failJob: vi.fn(),
  getJob: vi.fn(),
  getJobByOwner: vi.fn(),
  markProcessing: vi.fn(),
  completeJob: vi.fn(),
}));

vi.mock('../../lib/image-generate/queue', () => ({
  enqueueGeneration: vi.fn(),
  ensureWorkerStarted: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock('../../lib/image-generate/rate-limit', () => ({
  checkImageGenerateRateLimit: vi.fn(),
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
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const AUTHED = { user: { id: 'u1', email: 'loc@dang.com', name: 'Lockie' } };

describe('POST /api/image/generate integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createJob.mockResolvedValue({ jobId: 'img_test' });
    enqueueGeneration.mockResolvedValue({ jobId: 'img_test' });
    checkImageGenerateRateLimit.mockResolvedValue({
      allowed: true,
      limit: 5,
      remaining: 4,
      retryAfterSeconds: 3600,
    });
  });

  it('returns 405 for non-POST methods', async () => {
    const req = { method: 'GET', body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueGeneration).not.toHaveBeenCalled();
  });

  it('returns 401 without a session and does not create a job', async () => {
    readSession.mockReturnValue(null);
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueGeneration).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty prompt (no job created)', async () => {
    readSession.mockReturnValue(AUTHED);
    const req = { method: 'POST', body: { prompt: '   ' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/prompt/);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid dimension (no job created)', async () => {
    readSession.mockReturnValue(AUTHED);
    const req = { method: 'POST', body: { prompt: 'a cat', width: 300 } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 202 with a jobId when the job is queued', async () => {
    readSession.mockReturnValue(AUTHED);
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    // The job is recorded with the owning user and the validated prompt.
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: 'loc@dang.com',
        prompt: 'a cat',
      })
    );
    // The queue receives the validated payload (prompt + default size).
    expect(enqueueGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: 'a cat',
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      })
    );
  });

  it('returns 429 with Retry-After and creates no job when over quota', async () => {
    readSession.mockReturnValue(AUTHED);
    checkImageGenerateRateLimit.mockResolvedValue({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAfterSeconds: 90,
    });
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('90');
    expect(res.body.retryAfterSeconds).toBe(90);
    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueGeneration).not.toHaveBeenCalled();
  });

  it('fails closed when the rate limiter is unavailable', async () => {
    readSession.mockReturnValue(AUTHED);
    checkImageGenerateRateLimit.mockRejectedValue(new Error('redis down'));
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 503 when the job store is unavailable', async () => {
    readSession.mockReturnValue(AUTHED);
    createJob.mockRejectedValue(new Error('mongo down'));
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(enqueueGeneration).not.toHaveBeenCalled();
  });

  it('returns 503 and marks the job failed when enqueueing fails', async () => {
    readSession.mockReturnValue(AUTHED);
    enqueueGeneration.mockRejectedValue(new Error('redis down'));
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(createJob).toHaveBeenCalled();
    expect(failJob).toHaveBeenCalled();
  });
});
