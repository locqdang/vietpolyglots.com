import { beforeEach, describe, expect, it, vi } from 'vitest';
import quotaHandler from '../../pages/api/image/generate/quota';
import { readSession } from '../../lib/auth/session';
import { getRateLimitStatus } from '../../lib/image-generate/rate-limit';

vi.mock('../../lib/auth/session', () => ({
  readSession: vi.fn(),
}));

vi.mock('../../lib/image-generate/rate-limit', () => ({
  getRateLimitStatus: vi.fn(),
}));

function createMockRes() {
  return {
    statusCode: 200,
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

describe('GET /api/image/generate/quota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 405 for non-GET', async () => {
    const res = createMockRes();
    await quotaHandler({ method: 'POST' }, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 without a session', async () => {
    readSession.mockReturnValue(null);
    const res = createMockRes();
    await quotaHandler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(401);
    expect(getRateLimitStatus).not.toHaveBeenCalled();
  });

  it('returns the caller live usage for the owner', async () => {
    readSession.mockReturnValue(AUTHED);
    getRateLimitStatus.mockResolvedValue({
      limit: 15,
      used: 3,
      remaining: 12,
      windowSeconds: 3600,
      resetsInSeconds: 1800,
    });
    const res = createMockRes();
    await quotaHandler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(getRateLimitStatus).toHaveBeenCalledWith('loc@dang.com');
    expect(res.body).toEqual({
      limit: 15,
      used: 3,
      remaining: 12,
      windowSeconds: 3600,
      resetsInSeconds: 1800,
    });
  });

  it('returns 503 when the rate limiter is unavailable', async () => {
    readSession.mockReturnValue(AUTHED);
    getRateLimitStatus.mockRejectedValue(new Error('Redis not ready in time'));
    const res = createMockRes();
    await quotaHandler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
