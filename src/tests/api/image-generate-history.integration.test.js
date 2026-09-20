import { beforeEach, describe, expect, it, vi } from 'vitest';
import historyHandler from '../../pages/api/image/generate/history';
import { readSession } from '../../lib/auth/session';
import { listJobsByOwner } from '../../lib/image-generate/jobs';

vi.mock('../../lib/auth/session', () => ({ readSession: vi.fn() }));
vi.mock('../../lib/image-generate/jobs', () => ({ listJobsByOwner: vi.fn() }));

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
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const AUTHED = { user: { email: 'Loc@Example.com' } };

describe('GET /api/image/generate/history', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    readSession.mockReturnValue(null);
    const res = createMockRes();
    await historyHandler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(listJobsByOwner).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods', async () => {
    const res = createMockRes();
    await historyHandler({ method: 'POST', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns recent owner-scoped jobs without embedding image data', async () => {
    readSession.mockReturnValue(AUTHED);
    listJobsByOwner.mockResolvedValue({
      jobs: [
        {
          jobId: 'img_1',
          promptId: 'prompt_abc',
          prompt: 'a red dragon',
          negativePrompt: 'blurry',
          status: 'completed',
          seed: 42,
          createdAt: new Date('2026-09-20T10:00:00Z'),
          updatedAt: new Date('2026-09-20T10:01:00Z'),
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });

    const res = createMockRes();
    await historyHandler({ method: 'GET', query: { limit: '10' } }, res);

    expect(res.statusCode).toBe(200);
    expect(listJobsByOwner).toHaveBeenCalledWith('loc@example.com', { limit: 10, offset: 0 });
    expect(res.body.jobs[0]).toMatchObject({
      jobId: 'img_1',
      promptId: 'prompt_abc',
      prompt: 'a red dragon',
      negativePrompt: 'blurry',
    });
    expect(res.body.jobs[0].image).toBeUndefined();
    expect(res.body).toMatchObject({ total: 1, page: 1, totalPages: 1, limit: 10, offset: 0 });
  });

  it('clamps the requested history limit', async () => {
    readSession.mockReturnValue(AUTHED);
    listJobsByOwner.mockResolvedValue({ jobs: [], total: 0, limit: 50, offset: 0 });
    const res = createMockRes();
    await historyHandler({ method: 'GET', query: { limit: '500' } }, res);
    expect(listJobsByOwner).toHaveBeenCalledWith('loc@example.com', { limit: 50, offset: 0 });
  });

  it('computes page, offset and totalPages from the requested page', async () => {
    readSession.mockReturnValue(AUTHED);
    listJobsByOwner.mockResolvedValue({
      jobs: [{ jobId: 'img_2', prompt: 'page two' }],
      total: 25,
      limit: 12,
      offset: 12,
    });

    const res = createMockRes();
    await historyHandler({ method: 'GET', query: { page: '2', limit: '12' } }, res);

    expect(listJobsByOwner).toHaveBeenCalledWith('loc@example.com', { limit: 12, offset: 12 });
    expect(res.body).toMatchObject({ total: 25, page: 2, totalPages: 3, limit: 12, offset: 12 });
  });

  it('clamps page to at least one', async () => {
    readSession.mockReturnValue(AUTHED);
    listJobsByOwner.mockResolvedValue({ jobs: [], total: 0, limit: 12, offset: 0 });
    await historyHandler({ method: 'GET', query: { page: '0' } }, createMockRes());
    expect(listJobsByOwner).toHaveBeenCalledWith('loc@example.com', { limit: 12, offset: 0 });
  });
});
