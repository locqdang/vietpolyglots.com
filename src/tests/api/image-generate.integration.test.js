import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from '../../pages/api/image/generate';
import { generateImage, GateError } from '../../lib/image-generate/gate-client';
import { readSession } from '../../lib/auth/session';

vi.mock('../../lib/image-generate/gate-client', () => ({
  generateImage: vi.fn(),
  GateError: class GateError extends Error {
    constructor(status, message, detail) {
      super(message);
      this.name = 'GateError';
      this.status = status;
      this.detail = detail;
    }
  },
}));

vi.mock('../../lib/auth/session', () => ({
  readSession: vi.fn(),
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
  });

  it('returns 405 for non-POST methods', async () => {
    const req = { method: 'GET', body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('returns 401 without a session and does not call the gate', async () => {
    readSession.mockReturnValue(null);
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty prompt (no gate call) with a session', async () => {
    readSession.mockReturnValue(AUTHED);
    const req = { method: 'POST', body: { prompt: '   ' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/prompt/);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid dimension (no gate call)', async () => {
    readSession.mockReturnValue(AUTHED);
    const req = { method: 'POST', body: { prompt: 'a cat', width: 300 } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('returns 200 with image data URL when the gate succeeds', async () => {
    readSession.mockReturnValue(AUTHED);
    generateImage.mockResolvedValue({
      image: 'data:image/png;base64,AAAA',
      promptId: 'p-123',
      seed: 42,
    });
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    // Validated payload: prompt + default width/height (buildChromaPayload applies defaults).
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a cat', width: expect.any(Number), height: expect.any(Number) })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      image: 'data:image/png;base64,AAAA',
      promptId: 'p-123',
      seed: 42,
    });
  });

  it('maps a 504 GateError to a 504 response with a user-safe message', async () => {
    readSession.mockReturnValue(AUTHED);
    generateImage.mockRejectedValue(new GateError(504, 'Generation timed out — the GPU gate did not respond in time.', undefined));
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(504);
    expect(res.body.error).toMatch(/timed out/);
  });

  it('maps a 502 GateError to a 502 response', async () => {
    readSession.mockReturnValue(AUTHED);
    generateImage.mockRejectedValue(new GateError(502, 'Unable to reach the GPU gate. Please try again later.', undefined));
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(502);
  });

  it('maps an unexpected error to a 502 with a generic message', async () => {
    readSession.mockReturnValue(AUTHED);
    generateImage.mockRejectedValue(new Error('boom'));
    const req = { method: 'POST', body: { prompt: 'a cat' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/try again/);
  });
});
