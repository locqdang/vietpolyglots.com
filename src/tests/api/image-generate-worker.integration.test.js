import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processGenerationJob } from '../../lib/image-generate/queue';
import { generateImage, GateError } from '../../lib/image-generate/gate-client';
import { markProcessing, completeJob, failJob } from '../../lib/image-generate/jobs';

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

vi.mock('../../lib/image-generate/jobs', () => ({
  markProcessing: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  createJob: vi.fn(),
  getJob: vi.fn(),
  getJobByOwner: vi.fn(),
}));

describe('image-generate worker processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks processing, calls the gate, and completes the job on success', async () => {
    generateImage.mockResolvedValue({
      image: 'data:image/png;base64,AAAA',
      promptId: 'p-123',
      seed: 42,
    });
    const result = await processGenerationJob({ jobId: 'img_1', payload: { prompt: 'a cat' } });

    expect(markProcessing).toHaveBeenCalledWith('img_1');
    expect(generateImage).toHaveBeenCalledWith({ prompt: 'a cat' });
    expect(completeJob).toHaveBeenCalledWith('img_1', {
      image: 'data:image/png;base64,AAAA',
      promptId: 'p-123',
      seed: 42,
    });
    expect(failJob).not.toHaveBeenCalled();
    expect(result.promptId).toBe('p-123');
  });

  it('records a user-safe error and re-throws when the gate fails', async () => {
    generateImage.mockRejectedValue(
      new GateError(504, 'Generation timed out — the GPU gate did not respond in time.', undefined)
    );

    await expect(processGenerationJob({ jobId: 'img_2', payload: { prompt: 'a cat' } })).rejects.toBeInstanceOf(
      GateError
    );

    expect(markProcessing).toHaveBeenCalledWith('img_2');
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).toHaveBeenCalledWith(
      'img_2',
      expect.objectContaining({ error: expect.stringMatching(/timed out/) })
    );
  });

  it('maps a non-GateError to a generic message and re-throws', async () => {
    generateImage.mockRejectedValue(new Error('boom'));

    await expect(processGenerationJob({ jobId: 'img_3', payload: { prompt: 'a cat' } })).rejects.toThrow(
      'boom'
    );

    expect(failJob).toHaveBeenCalledWith(
      'img_3',
      expect.objectContaining({ error: expect.stringMatching(/try again/) })
    );
  });
});
