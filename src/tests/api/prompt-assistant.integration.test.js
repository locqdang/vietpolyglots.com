import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from '../../pages/api/image/prompt/assistant';
import { readSession } from '../../lib/auth/session';
import { checkPromptAssistantRateLimit } from '../../lib/image-generate/prompt-assistant-rate-limit';
import { enqueuePromptAssistant } from '../../lib/image-generate/prompt-assistant-queue';

vi.mock('../../lib/auth/session', () => ({ readSession: vi.fn() }));
vi.mock('../../lib/image-generate/prompt-assistant-rate-limit', () => ({
  checkPromptAssistantRateLimit: vi.fn(),
}));
vi.mock('../../lib/image-generate/prompt-assistant-queue', () => ({
  enqueuePromptAssistant: vi.fn(),
  promptAssistantOwnerId: vi.fn(() => 'owner-hash'),
}));

function res() {
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
    json(body) {
      this.body = body;
      return this;
    },
  };
}
const AUTHED = { user: { email: 'loc@dang.com' } };

describe('POST /api/image/prompt/assistant queue integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSession.mockReturnValue(AUTHED);
    checkPromptAssistantRateLimit.mockResolvedValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfterSeconds: 3600,
    });
    enqueuePromptAssistant.mockResolvedValue({ jobId: 'prompt_test' });
  });

  it('returns 405 for non-POST methods', async () => {
    const response = res();
    await handler({ method: 'GET', body: {} }, response);
    expect(response.statusCode).toBe(405);
    expect(enqueuePromptAssistant).not.toHaveBeenCalled();
  });
  it('returns 401 before rate limiting or enqueue', async () => {
    readSession.mockReturnValue(null);
    const response = res();
    await handler({ method: 'POST', body: { idea: 'a cat' } }, response);
    expect(response.statusCode).toBe(401);
    expect(checkPromptAssistantRateLimit).not.toHaveBeenCalled();
    expect(enqueuePromptAssistant).not.toHaveBeenCalled();
  });
  it('rejects empty and oversized ideas before enqueue', async () => {
    for (const idea of ['   ', 'a'.repeat(1001)]) {
      const response = res();
      await handler({ method: 'POST', body: { idea } }, response);
      expect(response.statusCode).toBe(400);
    }
    expect(enqueuePromptAssistant).not.toHaveBeenCalled();
  });
  it('returns 202 and queues an owner-scoped injection-safe request', async () => {
    const response = res();
    await handler({ method: 'POST', body: { idea: 'a cat' } }, response);
    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('queued');
    expect(response.body.jobId).toMatch(/^prompt_/);
    const queued = enqueuePromptAssistant.mock.calls[0][0];
    expect(queued.ownerId).toBe('owner-hash');
    expect(queued.chatRequest.messages[0].role).toBe('system');
    expect(queued.chatRequest.messages[1].content).toBe('a cat');
    expect(JSON.stringify(response.body)).not.toContain('8081');
  });
  it('returns 429 without enqueue when rate limited', async () => {
    checkPromptAssistantRateLimit.mockResolvedValue({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 120,
    });
    const response = res();
    await handler({ method: 'POST', body: { idea: 'a cat' } }, response);
    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('120');
    expect(enqueuePromptAssistant).not.toHaveBeenCalled();
  });
  it('fails closed when Redis rate limiting or enqueue is unavailable', async () => {
    checkPromptAssistantRateLimit.mockRejectedValueOnce(new Error('redis down'));
    let response = res();
    await handler({ method: 'POST', body: { idea: 'a cat' } }, response);
    expect(response.statusCode).toBe(503);
    checkPromptAssistantRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29 });
    enqueuePromptAssistant.mockRejectedValue(new Error('redis down'));
    response = res();
    await handler({ method: 'POST', body: { idea: 'a cat' } }, response);
    expect(response.statusCode).toBe(503);
  });
});
