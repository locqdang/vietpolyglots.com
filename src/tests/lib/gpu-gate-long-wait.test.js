import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitImageGeneration } from '../../lib/image-generate/gate-client';
import { generatePromptPair } from '../../lib/image-generate/prompt-assistant-gate';
import { getPromptAssistantConfig } from '../../lib/image-generate/prompt-assistant-config';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GPU gate long queue waits', () => {
  it('does not abort image submission after the former 120-second limit', async () => {
    vi.useFakeTimers();
    let respond;
    const fetchMock = vi.fn(() => new Promise((resolve) => (respond = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const pending = submitImageGeneration({ prompt: 'cat' });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    respond({ ok: true, json: async () => ({ prompt_id: 'p-1', seed: 42 }) });
    await expect(pending).resolves.toEqual({ promptId: 'p-1', seed: 42 });
  });

  it('does not abort prompt generation after the former 10-minute limit', async () => {
    vi.useFakeTimers();
    let respond;
    const fetchMock = vi.fn(() => new Promise((resolve) => (respond = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const config = { gateUrl: 'http://gpu-gate:8081', timeoutMs: 0, apiKey: '' };
    const pending = generatePromptPair({ messages: [] }, config);
    await vi.advanceTimersByTimeAsync(601_000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    respond({ ok: true, json: async () => ({ choices: [{ message: { content: 'done' } }] }) });
    await expect(pending).resolves.toBe('done');
  });

  it('defaults to waiting for the result unless an explicit positive timeout is configured', () => {
    const previous = process.env.PROMPT_ASSISTANT_TIMEOUT_MS;
    try {
      delete process.env.PROMPT_ASSISTANT_TIMEOUT_MS;
      expect(getPromptAssistantConfig().timeoutMs).toBe(0);
      process.env.PROMPT_ASSISTANT_TIMEOUT_MS = '300000';
      expect(getPromptAssistantConfig().timeoutMs).toBe(300_000);
    } finally {
      if (previous === undefined) delete process.env.PROMPT_ASSISTANT_TIMEOUT_MS;
      else process.env.PROMPT_ASSISTANT_TIMEOUT_MS = previous;
    }
  });
});
