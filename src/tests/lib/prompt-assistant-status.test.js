import { describe, expect, it } from 'vitest';
import {
  publicPromptAssistantStatus,
  promptAssistantGateRequestId,
} from '../../lib/image-generate/prompt-assistant-queue';

describe('publicPromptAssistantStatus', () => {
  it.each([
    ['waiting', 0, '', 'queued'],
    ['prioritized', 0, '', 'queued'],
    ['waiting-children', 0, '', 'queued'],
    ['delayed', 0, '', 'queued'],
    ['active', 0, '', 'starting'],
    ['active', 0, 'received', 'queued'],
    ['active', 0, 'waiting_for_gpu', 'waiting_for_gpu'],
    ['active', 0, 'preparing_gpu', 'preparing_gpu'],
    ['active', 0, 'admitted', 'processing'],
    ['active', 0, 'forwarded', 'processing'],
    ['delayed', 1, '', 'retrying'],
    ['completed', 2, 'forwarded', 'completed'],
    ['failed', 20, 'forwarded', 'failed'],
  ])(
    'maps BullMQ %s with %i attempts and gate stage %s to %s',
    (state, attemptsMade, gateStage, expected) => {
      expect(publicPromptAssistantStatus(state, attemptsMade, gateStage)).toBe(expected);
    }
  );
});

describe('promptAssistantGateRequestId', () => {
  it('uses the job id verbatim on the first attempt', () => {
    expect(promptAssistantGateRequestId({ id: 'prompt_mug1w5q7', attemptsMade: 0 })).toBe(
      'prompt_mug1w5q7'
    );
  });
  it('suffixes the attempt number on retries so each attempt has a unique gate id', () => {
    expect(promptAssistantGateRequestId({ id: 'prompt_mug1w5q7', attemptsMade: 1 })).toBe(
      'prompt_mug1w5q7-a1'
    );
    expect(promptAssistantGateRequestId({ id: 'prompt_mug1w5q7', attemptsMade: 2 })).toBe(
      'prompt_mug1w5q7-a2'
    );
  });
  it('is stable for the same attemptsMade (no drift within a single attempt)', () => {
    const a = promptAssistantGateRequestId({ id: 'prompt_mug1w5q7', attemptsMade: 3 });
    const b = promptAssistantGateRequestId({ id: 'prompt_mug1w5q7', attemptsMade: 3 });
    expect(a).toBe(b);
  });
  it('strips characters the gate rejects so the id is always accepted', () => {
    // The gate only accepts alphanumerics and -_.: ; everything else is dropped
    // so the id is never rejected and never falls back to a random uuid.
    expect(promptAssistantGateRequestId({ id: 'prompt_a/b\\c d', attemptsMade: 0 })).toBe(
      'prompt_abcd'
    );
  });
  it('handles a missing attemptsMade as the first attempt', () => {
    expect(promptAssistantGateRequestId({ id: 'prompt_mug1w5q7' })).toBe('prompt_mug1w5q7');
  });
});
