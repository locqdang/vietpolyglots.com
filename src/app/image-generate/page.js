'use client';

import { useRef, useState } from 'react';

const MAX_PROMPT = 10_000;

export default function ImageGeneratePage() {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState(null); // { image, promptId, seed }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [clientError, setClientError] = useState('');
  const reqIdRef = useRef(0);

  async function handleSubmit(event) {
    event.preventDefault();
    if (loading) return;

    setClientError('');
    setError('');
    setResult(null);

    const trimmed = prompt.trim();
    if (!trimmed) {
      setClientError('Please describe the image you want to create.');
      return;
    }
    if (trimmed.length > MAX_PROMPT) {
      setClientError('Your prompt is too long. Keep it under 10,000 characters.');
      return;
    }

    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const response = await fetch('/api/image/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
      });
      const data = await response.json().catch(() => null);
      if (reqId !== reqIdRef.current) return; // stale response, a newer request superseded it

      if (response.ok && data?.image) {
        setResult({ image: data.image, promptId: data.promptId, seed: data.seed });
      } else {
        setError(data?.error || 'Something went wrong while generating the image. Please try again.');
      }
    } catch {
      if (reqId === reqIdRef.current) {
        setError('Could not reach the server. Please check your connection and try again.');
      }
    } finally {
      if (reqId === reqIdRef.current) {
        setLoading(false);
      }
    }
  }

  return (
    <main className="image-generate">
      <section className="image-generate__hero">
        <p className="image-generate__eyebrow">Image Generation</p>
        <h1>Create an image from a description</h1>
        <p className="image-generate__intro">
          Describe what you want to see and we will generate it for you.
        </p>
      </section>

      <section className="image-generate__card">
        <form className="image-generate__form" onSubmit={handleSubmit} noValidate>
          <label className="image-generate__label" htmlFor="prompt">
            Describe your image
          </label>
          <textarea
            id="prompt"
            name="prompt"
            className="image-generate__textarea"
            rows={4}
            maxLength={MAX_PROMPT}
            placeholder="e.g. A watercolor red dragon flying over misty mountains at sunrise"
            value={prompt}
            disabled={loading}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {clientError ? <p className="image-generate__error">{clientError}</p> : null}

          <button type="submit" className="btn" disabled={loading}>
            {loading ? 'Generating…' : 'Generate image'}
          </button>
        </form>

        {loading ? <div className="image-generate__status" aria-live="polite">Generating your image, this can take a moment…</div> : null}
        {error ? (
          <div className="image-generate__errorbox" role="alert">
            <p>{error}</p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={handleSubmit}>
              Try again
            </button>
          </div>
        ) : null}

        {result ? (
          <figure className="image-generate__result">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.image} alt="Generated image" className="image-generate__img" />
            <figcaption className="image-generate__meta">
              Seed {result.seed}
            </figcaption>
          </figure>
        ) : null}
      </section>
    </main>
  );
}
