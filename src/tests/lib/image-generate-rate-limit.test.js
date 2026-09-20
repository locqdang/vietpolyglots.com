import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkImageGenerateRateLimit,
  getRateLimitConfig,
  getRateLimitStatus,
} from '../../lib/image-generate/rate-limit';

const redisMock = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
  pttl: vi.fn(),
  on: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    constructor() {
      this.status = 'ready';
      this.eval = redisMock.eval;
      this.get = redisMock.get;
      this.pttl = redisMock.pttl;
      this.on = redisMock.on;
    }
  },
}));

const originalEnv = { ...process.env };

describe('image generation rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('uses safe configurable defaults', () => {
    delete process.env.IMAGE_GEN_RATE_LIMIT_MAX;
    delete process.env.IMAGE_GEN_RATE_LIMIT_WINDOW_SECONDS;
    expect(getRateLimitConfig()).toEqual({ max: 15, windowSeconds: 3600 });
  });

  it('clamps invalid configuration to defaults', () => {
    process.env.IMAGE_GEN_RATE_LIMIT_MAX = '0';
    process.env.IMAGE_GEN_RATE_LIMIT_WINDOW_SECONDS = 'not-a-number';
    expect(getRateLimitConfig()).toEqual({ max: 15, windowSeconds: 3600 });
  });

  it('allows a request and reports remaining quota', async () => {
    redisMock.eval.mockResolvedValue([3, 45_000]);
    const result = await checkImageGenerateRateLimit('loc@example.com');
    expect(result).toEqual({ allowed: true, limit: 15, remaining: 12, retryAfterSeconds: 45 });
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/^image-generate:rate:[a-f0-9]{64}$/),
      '3600000'
    );
    expect(redisMock.eval.mock.calls[0][2]).not.toContain('loc@example.com');
  });

  it('rejects over-quota requests with a rounded-up retry interval', async () => {
    redisMock.eval.mockResolvedValue([16, 1_001]);
    const result = await checkImageGenerateRateLimit('loc@example.com');
    expect(result).toEqual({ allowed: false, limit: 15, remaining: 0, retryAfterSeconds: 2 });
  });

  it('reads current usage without consuming an attempt', async () => {
    redisMock.get.mockResolvedValue('7');
    redisMock.pttl.mockResolvedValue(2_400_000);
    const result = await getRateLimitStatus('loc@example.com');
    expect(result).toEqual({
      limit: 15,
      used: 7,
      remaining: 8,
      windowSeconds: 3600,
      resetsInSeconds: 2400,
    });
    // Read-only: must not touch the INCR script.
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(redisMock.get.mock.calls[0][0]).not.toContain('loc@example.com');
  });

  it('reports a fresh window when no usage is stored', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.pttl.mockResolvedValue(-2);
    const result = await getRateLimitStatus('loc@example.com');
    expect(result).toEqual({
      limit: 15,
      used: 0,
      remaining: 15,
      windowSeconds: 3600,
      resetsInSeconds: 0,
    });
  });

  it('clamps usage at the limit when the counter exceeds it', async () => {
    redisMock.get.mockResolvedValue('21');
    redisMock.pttl.mockResolvedValue(1000);
    const result = await getRateLimitStatus('loc@example.com');
    expect(result.used).toBe(15);
    expect(result.remaining).toBe(0);
  });
});
