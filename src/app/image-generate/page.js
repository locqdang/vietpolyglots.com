'use client';

import { useEffect, useRef, useState } from 'react';

const MAX_PROMPT = 10_000;
const POLL_INTERVAL_MS = 1500;
// Generous because the real wait is the GPU gate: a render is ~30s, but the job
// first waits for the GPU while the LLM holds it (observed holds up to ~5 min).
// The "Queued" stage tells the user they're waiting, so let the poll run long
// enough to actually see it advance to "Generating" and "Success".
const POLL_TIMEOUT_MS = 420_000; // hard cap so the UI never hangs

// Recent-generations pagination: keep the list light and let older items page in.
const HISTORY_PAGE_SIZE = 12;

const STATUS_LABELS = {
  queued: 'Waiting for the GPU…',
  processing: 'Generating your image…',
  completed: 'Done',
  failed: 'Failed',
};

// Pipeline stages shown in the progress stepper, in order. The gate reports the
// job's current stage (queued/processing/completed); the stepper lights up the
// active step and marks every earlier step done.
const PROGRESS_STEPS = ['Queued', 'Generating', 'Success'];
const STAGE_INDEX = { queued: 0, processing: 1, completed: 2 };
// The progress bar is a direct visual twin of the stepper: both are driven by
// the same `stage` value, so the text, the step illustration, and the bar can
// never disagree. The fill tracks "how far through the 3-step pipeline" we've
// reached (the active step is the leading edge of the bar).
const STAGE_BAR_PERCENT = { queued: 33, processing: 66, completed: 100 };

function ProgressStepper({ stage }) {
  // On completion every step is done (Success included); otherwise light up the
  // active step and mark all earlier steps done.
  const activeIndex =
    stage === 'completed' ? PROGRESS_STEPS.length : STAGE_INDEX[stage] ?? 0;
  return (
    <ol className="image-generate__steps">
      {PROGRESS_STEPS.map((label, index) => {
        const state =
          activeIndex > index ? 'done' : activeIndex === index ? 'active' : 'todo';
        return (
          <li
            key={label}
            className={`image-generate__step image-generate__step--${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="image-generate__step-dot" aria-hidden="true">
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="image-generate__step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Never let the reported stage move backwards (a stale gate "queued" must not
// yank a "processing" job back to step one).
function advanceStage(current, next) {
  if (!(next in STAGE_INDEX)) return current;
  if ((STAGE_INDEX[current] ?? -1) >= STAGE_INDEX[next]) return current;
  return next;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export default function ImageGeneratePage() {
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusLabel, setStatusLabel] = useState('');
  const [stage, setStage] = useState('queued');
  const [quota, setQuota] = useState(null);
  const [result, setResult] = useState(null); // { image, seed, promptId, jobId, prompt, negativePrompt }
  const [activeJob, setActiveJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [thumbnails, setThumbnails] = useState({});
  const [historyLoading, setHistoryLoading] = useState(true);
  const [retentionDays, setRetentionDays] = useState(30);
  const [rateLimit, setRateLimit] = useState(null);
  const [error, setError] = useState('');
  const [clientError, setClientError] = useState('');
  const pollRef = useRef(0);
  const mountedRef = useRef(true);
  const thumbRef = useRef(new Set());

  useEffect(() => {
    mountedRef.current = true;
    // Pre-fill the negative prompt with the server default (secret-free endpoint).
    fetch('/api/image/generate/config', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (mountedRef.current && data) {
          if (data.defaultNegative) {
            setNegative((current) => current || data.defaultNegative);
          }
          if (data.retentionDays) setRetentionDays(data.retentionDays);
          if (data.rateLimit) setRateLimit(data.rateLimit);
        }
      })
      .catch(() => {});
    refreshHistory();
    refreshQuota();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function stopPolling() {
    pollRef.current += 1;
  }

  // No-argument calls (the initial mount load) always want page 1; every other
  // caller passes an explicit page. Defaulting to a constant (not the historyPage
  // state) keeps this stable for the mount-once effect below.
  async function refreshHistory(page = 1) {
    try {
      const response = await fetch(
        `/api/image/generate/history?page=${page}&limit=${HISTORY_PAGE_SIZE}`,
        { credentials: 'same-origin' }
      );
      const data = await response.json().catch(() => null);
      if (mountedRef.current && response.ok) {
        setHistory(data?.jobs || []);
        setHistoryTotal(data?.total ?? 0);
        if (typeof data?.page === 'number') setHistoryPage(data.page);
      }
    } catch {
      // History is secondary to generation; keep the form usable if it fails.
    } finally {
      if (mountedRef.current) setHistoryLoading(false);
    }
  }

  function goHistoryPage(next) {
    const target = Math.max(1, next);
    setHistoryLoading(true);
    refreshHistory(target);
  }

  // Read-only live quota for the owner. Never blocks the form: a failure (e.g.
  // Redis blip, 503) keeps whatever quota the UI already shows.
  async function refreshQuota() {
    try {
      const response = await fetch('/api/image/generate/quota', { credentials: 'same-origin' });
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      if (mountedRef.current && data && typeof data.remaining === 'number') setQuota(data);
    } catch {
      // Quota is decorative; ignore failures.
    }
  }

  // Downscale a full image data URL to a small client-side thumbnail so the
  // recent-generations list stays light. No server round trip, no new deps.
  function ensureThumbnail(jobId, dataUrl) {
    if (thumbRef.current.has(jobId) || typeof Image === 'undefined') return;
    thumbRef.current.add(jobId);
    const image = new Image();
    image.onload = () => {
      try {
        const target = 160;
        const scale = Math.min(1, target / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const thumb = canvas.toDataURL('image/jpeg', 0.75);
        if (mountedRef.current) setThumbnails((current) => ({ ...current, [jobId]: thumb }));
      } catch {
        // Thumbnail is decorative; ignore canvas failures.
      }
    };
    image.src = dataUrl;
  }

  useEffect(() => {
    if (!history.length) return;
    history
      .filter((job) => job.status === 'completed')
      .forEach((job) => {
        fetch(`/api/image/generate/${job.jobId}`, { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (mountedRef.current && data?.image) ensureThumbnail(job.jobId, data.image);
          })
          .catch(() => {});
      });
  }, [history]);

  async function loadHistoryJob(job) {
    setClientError('');
    setError('');
    if (job.status === 'queued' || job.status === 'processing') {
      setLoading(true);
      setStatusLabel(STATUS_LABELS[job.status]);
      setStage(job.status === 'processing' ? 'processing' : 'queued');
      await pollStatus(job.jobId, job.promptId);
      return;
    }

    try {
      const response = await fetch(`/api/image/generate/${job.jobId}`, {
        credentials: 'same-origin',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.image) {
        setError(data?.error || 'This saved image is no longer available.');
        return;
      }
      setResult({
        image: data.image,
        seed: data.seed,
        promptId: data.promptId,
        jobId: data.jobId,
        prompt: data.prompt,
        negativePrompt: data.negativePrompt || '',
      });
      // Loading an image also restores the prompt that created it.
      if (data.prompt) setPrompt(data.prompt);
      if (data.negativePrompt) setNegative(data.negativePrompt);
      ensureThumbnail(data.jobId, data.image);
    } catch {
      setError('Could not load this saved image. Please try again.');
    }
  }

  async function tryAgain(job) {
    const savedPrompt = String(job?.prompt || '').trim();
    if (!savedPrompt) return;
    setPrompt(savedPrompt);
    setNegative(String(job?.negativePrompt || ''));
    setHistory((current) => current.filter((item) => item.jobId !== job.jobId));
    await submitGeneration(savedPrompt, String(job?.negativePrompt || ''), job.jobId);
  }

  async function resumeJob(job) {
    setClientError('');
    setError('');
    setResult(null);
    setLoading(true);
    setStatusLabel(STATUS_LABELS[job.status] || STATUS_LABELS.processing);
    setStage(job.status === 'processing' ? 'processing' : 'queued');
    await pollStatus(job.jobId, job.promptId);
  }

  async function pollStatus(jobId, initialPromptId = null) {
    const pollId = ++pollRef.current;
    const startedAt = Date.now();
    let promptId = initialPromptId;

    while (true) {
      if (!mountedRef.current || pollId !== pollRef.current) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setError('This is taking longer than expected. Please try again.');
        setLoading(false);
        return;
      }

      try {
        const statusUrl = promptId
          ? `/api/image/generate/${jobId}?promptId=${encodeURIComponent(promptId)}`
          : `/api/image/generate/${jobId}`;
        const res = await fetch(statusUrl, { credentials: 'same-origin' });
        const data = await res.json().catch(() => null);
        if (!mountedRef.current || pollId !== pollRef.current) return;

        if (res.ok && data) {
          if (data.promptId) {
            promptId = data.promptId;
            setActiveJob((current) => ({ ...(current || {}), jobId, promptId }));
          }
          if (data.status === 'completed') {
            setResult({
              image: data.image,
              seed: data.seed,
              promptId: data.promptId,
              jobId: data.jobId,
              prompt: data.prompt,
              negativePrompt: data.negativePrompt || '',
            });
            if (data.image) ensureThumbnail(data.jobId, data.image);
            setStage('completed');
            setStatusLabel('');
            setLoading(false);
            await refreshHistory(1);
            return;
          }
          if (data.status === 'failed') {
            setActiveJob((current) => ({
              ...(current || {}),
              jobId: data.jobId,
              promptId: data.promptId,
              prompt: data.prompt,
              negativePrompt: data.negativePrompt || '',
              status: 'failed',
            }));
            setError(data.error || 'Image generation failed. Please try again.');
            setStage('queued');
            setStatusLabel('');
            setLoading(false);
            return;
          }
          setStatusLabel(STATUS_LABELS[data.status] || STATUS_LABELS.queued);
          // Advance the stepper to the gate's reported stage, but never backwards.
          // The progress bar is driven from this same stage, so it can't drift.
          setStage((current) => advanceStage(current, data.status));
        }
      } catch {
        // Network blip while polling — keep going until the timeout.
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async function submitGeneration(promptText, negativeText, replaceFailedJobId = '') {
    if (loading) return;
    setClientError('');
    setError('');
    setResult(null);
    setLoading(true);
    setStatusLabel(STATUS_LABELS.queued);
    setStage('queued');

    try {
      const response = await fetch('/api/image/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText,
          negative_prompt: negativeText.trim() || undefined,
          replace_failed_job_id: replaceFailedJobId || undefined,
        }),
      });
      // Every attempt (accepted or rate-limited) consumes the server counter, so
      // refresh the live quota regardless of the outcome.
      refreshQuota();
      const data = await response.json().catch(() => null);

      if (response.status === 202 && data?.jobId) {
        setActiveJob({ jobId: data.jobId, promptId: null, status: 'queued' });
        await refreshHistory(1);
        await pollStatus(data.jobId);
        return;
      }

      setError(data?.error || 'Something went wrong while generating the image. Please try again.');
      setLoading(false);
    } catch {
      setError('Could not reach the server. Please check your connection and try again.');
      setLoading(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (loading) return;

    setClientError('');
    setError('');

    const trimmed = prompt.trim();
    if (!trimmed) {
      setClientError('Please describe the image you want to create.');
      return;
    }
    if (trimmed.length > MAX_PROMPT) {
      setClientError('Your prompt is too long. Keep it under 10,000 characters.');
      return;
    }
    if (!accepted) {
      setClientError('Please confirm you understand the notice above before generating.');
      return;
    }

    await submitGeneration(trimmed, negative);
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
        <div className="image-generate__notice" role="note">
          <h2 className="image-generate__notice-title">Please read before generating</h2>
          <p>
            Images are created by an AI model and are provided for personal use only. You are
            solely responsible for how you use any image you generate. The site owner provides this
            service “as is”, without warranties of any kind, and is not responsible for the content
            of generated images or for any use you make of them. Do not generate images of real,
            identifiable people, or content that is illegal, infringes another&rsquo;s rights, or
            violates applicable law or this site&rsquo;s terms of service. By checking the box below
            you confirm you have read and agree to these terms.
          </p>
          <label className="image-generate__consent">
            <input
              type="checkbox"
              checked={accepted}
              disabled={loading}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>I have read and agree to the notice above.</span>
          </label>
        </div>

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

          <details className="image-generate__advanced">
            <summary className="image-generate__advanced-summary">Options (negative prompt)</summary>
            <label className="image-generate__label" htmlFor="negative">
              Things to avoid (optional)
            </label>
            <textarea
              id="negative"
              name="negative"
              className="image-generate__textarea image-generate__textarea--sm"
              rows={2}
              maxLength={10_000}
              placeholder="e.g. blurry, watermark, text"
              value={negative}
              disabled={loading}
              onChange={(event) => setNegative(event.target.value)}
            />
          </details>

          {clientError ? <p className="image-generate__error">{clientError}</p> : null}

          <button type="submit" className="btn" disabled={loading}>
            {loading ? 'Generating…' : 'Generate image'}
          </button>
          {rateLimit ? (
            <p className="image-generate__quota">
              {quota
                ? `Used ${quota.used} of ${quota.limit} generations${
                    quota.resetsInSeconds > 0
                      ? ` · resets in ${Math.max(1, Math.round(quota.resetsInSeconds / 60))} min`
                      : ''
                  }.`
                : `Limit: ${rateLimit.max} generations every ${Math.round(
                    rateLimit.windowSeconds / 60
                  )} minutes.`}
            </p>
          ) : null}
        </form>

        {loading ? (
          <div className="image-generate__status" aria-live="polite">
            <ProgressStepper stage={stage} />
            <div
              className="image-generate__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={STAGE_BAR_PERCENT[stage] ?? 0}
            >
              <div
                className="image-generate__bar-fill"
                style={{ width: `${STAGE_BAR_PERCENT[stage] ?? 0}%` }}
              />
            </div>
            <p>{statusLabel || 'Working…'}</p>
          </div>
        ) : null}

        {error ? (
          <div className="image-generate__errorbox" role="alert">
            <p>{error}</p>
            {activeJob ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  activeJob.status === 'failed' ? tryAgain(activeJob) : resumeJob(activeJob)
                }
              >
                {activeJob.status === 'failed' ? 'Try again' : 'Resume'}
              </button>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <figure className="image-generate__result">
            <ProgressStepper stage="completed" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.image} alt="Generated image" className="image-generate__img" />
          </figure>
        ) : null}

        <section className="image-generate__history" aria-labelledby="image-history-title">
          <div className="image-generate__history-heading">
            <div>
              <h2 id="image-history-title">Recent generations</h2>
              <p>
                {historyTotal > 0
                  ? `Showing ${history.length} of ${historyTotal} · retained for up to ${retentionDays} days.`
                  : `Completed images are retained for up to ${retentionDays} days.`}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={historyLoading}
              onClick={() => refreshHistory(1)}
            >
              Refresh
            </button>
          </div>

          {historyLoading ? <p>Loading history…</p> : null}
          {!historyLoading && history.length === 0 ? <p>No generations yet.</p> : null}
          {history.length > 0 ? (
            <>
              <ul className="image-generate__history-list">
                {history.map((job) => (
                  <li key={job.jobId} className="image-generate__history-item">
                    <div className="image-generate__history-thumb">
                      {job.status === 'completed' && thumbnails[job.jobId] ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={thumbnails[job.jobId]}
                          alt={`Thumbnail: ${job.prompt}`}
                          className="image-generate__thumb-img"
                        />
                      ) : null}
                    </div>
                    <div className="image-generate__history-copy">
                      <strong>{job.prompt}</strong>
                      <span>
                        {STATUS_LABELS[job.status] || job.status}
                        {job.createdAt ? ` · ${formatDate(job.createdAt)}` : ''}
                      </span>
                    </div>
                    <div className="image-generate__history-actions">
                      {job.status === 'completed' ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={loading}
                          onClick={() => loadHistoryJob(job)}
                        >
                          Load
                        </button>
                      ) : job.status === 'failed' ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={loading || !job.prompt}
                          onClick={() => tryAgain(job)}
                        >
                          Try again
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={loading || !job.promptId}
                          onClick={() => resumeJob(job)}
                        >
                          Resume
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {historyTotal > HISTORY_PAGE_SIZE ? (
                <nav className="image-generate__pagination" aria-label="History pages">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={historyLoading || historyPage <= 1}
                    onClick={() => goHistoryPage(historyPage - 1)}
                  >
                    ← Previous
                  </button>
                  <span className="image-generate__pagination-status" aria-live="polite">
                    Page {historyPage} of {Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE))}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={
                      historyLoading || historyPage >= Math.ceil(historyTotal / HISTORY_PAGE_SIZE)
                    }
                    onClick={() => goHistoryPage(historyPage + 1)}
                  >
                    Next →
                  </button>
                </nav>
              ) : null}
            </>
          ) : null}
        </section>
      </section>
    </main>
  );
}
