import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processGenerationJob } from '../../lib/image-generate/queue';
import {
  submitImageGeneration,
  getImageGenerationStatus,
  GateError,
} from '../../lib/image-generate/gate-client';
import {
  markProcessing,
  attachPromptId,
  completeJob,
  failJob,
} from '../../lib/image-generate/jobs';

vi.mock('../../lib/image-generate/gate-client', () => ({
  submitImageGeneration: vi.fn(),
  getImageGenerationStatus: vi.fn(),
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
  attachPromptId: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  createJob: vi.fn(),
  getJob: vi.fn(),
  getJobByOwner: vi.fn(),
}));

describe('image-generate worker processor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists promptId, polls by promptId, and completes on success', async () => {
    submitImageGeneration.mockResolvedValue({ promptId: 'p-123', seed: 42 });
    getImageGenerationStatus
      .mockResolvedValueOnce({ status: 'processing', promptId: 'p-123' })
      .mockResolvedValueOnce({
        status: 'completed',
        image: 'data:image/png;base64,AAAA',
        promptId: 'p-123',
      });

    const result = await processGenerationJob({ jobId: 'img_1', payload: { prompt: 'a cat' } });

    // The worker no longer flips the job to "processing" up front: it stays
    // "queued" until the gate accepts the prompt (the GPU wait happens inside the
    // gate's submit). attachPromptId is what moves it to "processing".
    expect(markProcessing).not.toHaveBeenCalled();
    expect(submitImageGeneration).toHaveBeenCalledWith({ prompt: 'a cat' });
    expect(attachPromptId).toHaveBeenCalledWith('img_1', { promptId: 'p-123', seed: 42 });
    expect(getImageGenerationStatus).toHaveBeenCalledWith('p-123');
    expect(completeJob).toHaveBeenCalledWith('img_1', {
      status: 'completed',
      image: 'data:image/png;base64,AAAA',
      promptId: 'p-123',
      seed: 42,
    });
    expect(failJob).not.toHaveBeenCalled();
    expect(result.promptId).toBe('p-123');
  }, 10_000);

  it('records a user-safe error and re-throws when submission fails', async () => {
    submitImageGeneration.mockRejectedValue(
      new GateError(504, 'Generation timed out — the GPU gate did not respond in time.')
    );

    await expect(
      processGenerationJob({ jobId: 'img_2', payload: { prompt: 'a cat' } })
    ).rejects.toBeInstanceOf(GateError);
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).toHaveBeenCalledWith(
      'img_2',
      expect.objectContaining({ error: expect.stringMatching(/timed out/) })
    );
  });

  it('maps a non-GateError to a generic message and re-throws', async () => {
    submitImageGeneration.mockRejectedValue(new Error('boom'));
    await expect(
      processGenerationJob({ jobId: 'img_3', payload: { prompt: 'a cat' } })
    ).rejects.toThrow('boom');
    expect(failJob).toHaveBeenCalledWith(
      'img_3',
      expect.objectContaining({ error: expect.stringMatching(/try again/) })
    );
  });
});
