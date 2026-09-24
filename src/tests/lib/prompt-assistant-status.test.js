import { describe, expect, it } from 'vitest';
import { publicPromptAssistantStatus } from '../../lib/image-generate/prompt-assistant-queue';

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
