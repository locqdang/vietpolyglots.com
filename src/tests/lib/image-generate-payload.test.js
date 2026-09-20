import { describe, it, expect } from 'vitest';
import { buildChromaPayload } from '../../lib/image-generate/payload';

describe('buildChromaPayload', () => {
  it('builds a minimal payload with the prompt and default size', () => {
    const result = buildChromaPayload({ prompt: '  a red dragon  ' });
    expect(result.ok).toBe(true);
    // No size provided → defaults (1024 in the test env; IMAGE_GEN_DEFAULT_* unset).
    expect(result.payload).toEqual({ prompt: 'a red dragon', width: 1024, height: 1024 });
  });

  it('trims the prompt', () => {
    const result = buildChromaPayload({ prompt: '  a red dragon  ' });
    expect(result.payload.prompt).toBe('a red dragon');
  });

  it('passes through provided optional params', () => {
    const result = buildChromaPayload({
      prompt: 'a cat',
      negative_prompt: 'blurry',
      width: 512,
      height: 512,
      steps: 12,
      seed: 42,
      cfg: 3.5,
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      prompt: 'a cat',
      negative_prompt: 'blurry',
      width: 512,
      height: 512,
      steps: 12,
      seed: 42,
      cfg: 3.5,
    });
  });

  it('falls back to the default size when width/height are omitted', () => {
    const result = buildChromaPayload({ prompt: 'a cat', width: undefined, height: undefined });
    expect(result.ok).toBe(true);
    expect(result.payload.width).toBe(1024);
    expect(result.payload.height).toBe(1024);
  });

  it('rejects an empty or whitespace-only prompt', () => {
    expect(buildChromaPayload({ prompt: '' }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: '   ' }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: undefined }).ok).toBe(false);
    expect(buildChromaPayload({}).ok).toBe(false);
  });

  it('rejects an oversized prompt (> 10000 chars)', () => {
    const result = buildChromaPayload({ prompt: 'a'.repeat(10_001) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/prompt/);
  });

  it('rejects an oversized negative prompt', () => {
    const result = buildChromaPayload({ prompt: 'x', negative_prompt: 'a'.repeat(10_001) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/negative/);
  });

  it.each([
    [255, 'width'],
    [2049, 'width'],
    [257, 'width'], // not a multiple of 8
    [300, 'height'], // not a multiple of 8
    [1023, 'width'], // not a multiple of 8
  ])('rejects %i as %s (must be 256-2048 and a multiple of 8)', (value, field) => {
    const result = buildChromaPayload({ prompt: 'x', [field]: value });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(new RegExp(field));
  });

  it('accepts boundary dimension values', () => {
    expect(buildChromaPayload({ prompt: 'x', width: 256, height: 2048 }).ok).toBe(true);
  });

  it('rejects out-of-range steps', () => {
    expect(buildChromaPayload({ prompt: 'x', steps: 0 }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: 'x', steps: 101 }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: 'x', steps: 1 }).ok).toBe(true);
    expect(buildChromaPayload({ prompt: 'x', steps: 100 }).ok).toBe(true);
  });

  it('rejects out-of-range cfg', () => {
    expect(buildChromaPayload({ prompt: 'x', cfg: -1 }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: 'x', cfg: 21 }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: 'x', cfg: 0 }).ok).toBe(true);
    expect(buildChromaPayload({ prompt: 'x', cfg: 20 }).ok).toBe(true);
  });

  it('rejects boolean / non-numeric dimension values', () => {
    expect(buildChromaPayload({ prompt: 'x', width: true }).ok).toBe(false);
    expect(buildChromaPayload({ prompt: 'x', steps: '10' }).ok).toBe(false);
  });
});
