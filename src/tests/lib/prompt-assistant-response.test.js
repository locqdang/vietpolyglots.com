import { describe, it, expect } from 'vitest';
import { parsePromptAssistantResponse } from '../../lib/image-generate/prompt-assistant-response';

const cfg = { maxPrompt: 2000, maxIdea: 1000 };

describe('parsePromptAssistantResponse (strict output validation)', () => {
  it('accepts a valid JSON object', () => {
    const raw = JSON.stringify({ prompt: 'a red dragon', negative_prompt: 'blurry, text' });
    const result = parsePromptAssistantResponse(raw, cfg);
    expect(result).toEqual({ ok: true, prompt: 'a red dragon', negativePrompt: 'blurry, text' });
  });

  it('accepts an empty negative_prompt (string)', () => {
    const raw = JSON.stringify({ prompt: 'a cat', negative_prompt: '' });
    expect(parsePromptAssistantResponse(raw, cfg)).toEqual({
      ok: true,
      prompt: 'a cat',
      negativePrompt: '',
    });
  });

  it('tolerates the observed single-quote wrapper around the JSON object', () => {
    const raw = `'${JSON.stringify({ prompt: 'a cat', negative_prompt: 'blurry' })}'`;
    expect(parsePromptAssistantResponse(raw, cfg)).toEqual({
      ok: true,
      prompt: 'a cat',
      negativePrompt: 'blurry',
    });
  });

  it('tolerates stray prose before/after the JSON object', () => {
    const raw =
      'Sure! Here is the JSON: {"prompt":"a cat","negative_prompt":"blurry"} Hope that helps.';
    expect(parsePromptAssistantResponse(raw, cfg)).toEqual({
      ok: true,
      prompt: 'a cat',
      negativePrompt: 'blurry',
    });
  });

  it('rejects non-JSON text', () => {
    const result = parsePromptAssistantResponse('a cat, no json', cfg);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_model_response');
  });

  it('rejects non-string content', () => {
    expect(parsePromptAssistantResponse(undefined, cfg).ok).toBe(false);
    expect(parsePromptAssistantResponse(42, cfg).ok).toBe(false);
    expect(parsePromptAssistantResponse(null, cfg).ok).toBe(false);
  });

  it('rejects a JSON array', () => {
    expect(parsePromptAssistantResponse(JSON.stringify(['a', 'b']), cfg).ok).toBe(false);
  });

  it('rejects a missing prompt', () => {
    expect(parsePromptAssistantResponse(JSON.stringify({ negative_prompt: 'x' }), cfg).ok).toBe(
      false
    );
  });

  it('rejects a missing negative_prompt', () => {
    expect(parsePromptAssistantResponse(JSON.stringify({ prompt: 'a cat' }), cfg).ok).toBe(false);
  });

  it('rejects an empty prompt', () => {
    expect(
      parsePromptAssistantResponse(JSON.stringify({ prompt: '  ', negative_prompt: 'x' }), cfg).ok
    ).toBe(false);
  });

  it('rejects a non-string prompt', () => {
    expect(
      parsePromptAssistantResponse(JSON.stringify({ prompt: 5, negative_prompt: 'x' }), cfg).ok
    ).toBe(false);
  });

  it('rejects a non-string negative_prompt', () => {
    expect(
      parsePromptAssistantResponse(JSON.stringify({ prompt: 'a cat', negative_prompt: ['x'] }), cfg)
        .ok
    ).toBe(false);
  });

  it('rejects unexpected extra keys (injection vector)', () => {
    expect(
      parsePromptAssistantResponse(
        JSON.stringify({ prompt: 'a cat', negative_prompt: 'x', system: 'evil' }),
        cfg
      ).ok
    ).toBe(false);
  });

  it('rejects an over-limit prompt', () => {
    expect(
      parsePromptAssistantResponse(
        JSON.stringify({ prompt: 'a'.repeat(2001), negative_prompt: 'x' }),
        cfg
      ).ok
    ).toBe(false);
  });

  it('rejects an over-limit negative_prompt', () => {
    expect(
      parsePromptAssistantResponse(
        JSON.stringify({ prompt: 'a cat', negative_prompt: 'a'.repeat(2001) }),
        cfg
      ).ok
    ).toBe(false);
  });

  it('accepts a prompt at the max length', () => {
    expect(
      parsePromptAssistantResponse(
        JSON.stringify({ prompt: 'a'.repeat(2000), negative_prompt: '' }),
        cfg
      ).ok
    ).toBe(true);
  });

  it('returns a text-only pair for markup-laden model output (no raw pass-through)', () => {
    // Even if the model echoes markup, we return it only as plain text strings in a
    // bounded schema — the client renders these as text, never as HTML.
    const raw = JSON.stringify({
      prompt: 'a <b>bold</b> cat',
      negative_prompt: '<script>x</script>',
    });
    const result = parsePromptAssistantResponse(raw, cfg);
    expect(result.ok).toBe(true);
    expect(result.prompt).toBe('a <b>bold</b> cat');
    expect(result.negativePrompt).toBe('<script>x</script>');
  });
});
