const { test, expect } = require('@playwright/test');
const { signInWithMagicLink } = require('./helpers/route-auth');

// The assistant backend is the LLM gate, which shares the GPU with image
// generation and is slow/expensive. So the assistant API call is STUBBED via
// page.route — the E2E verifies the *client* behavior (fields populate on
// success, validation blocks empty, errors leave fields unchanged, and the
// gate host never leaks), not the model. The backend itself is covered by the
// vitest integration tests + the live-model smoke (specs/008 quickstart.md).
const ASSISTANT_URL = '**/api/image/prompt/assistant';

test.describe('Services → Image Generate → Prompt Assistant', () => {
  test('redirects unauthenticated users to login (assistant not reachable signed out)', async ({
    page,
  }) => {
    await page.goto('/image-generate');

    await page.waitForURL('**/login?redirect=*');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fimage-generate$/);
  });

  test('blocks the assistant on an empty idea (client-side, no API call)', async ({
    page,
    request,
  }) => {
    let apiCalled = false;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/image/prompt/assistant')) {
        apiCalled = true;
      }
    });

    await signInWithMagicLink(page, request, {
      email: 'e2e-prompt-assistant@example.com',
      redirectPath: '/image-generate',
    });

    const idea = page.getByLabel(/Describe your idea/i);
    const assistButton = page.getByRole('button', { name: /Help generate prompt/i });
    await expect(idea).toBeVisible();
    await expect(assistButton).toBeVisible();

    await assistButton.click({ force: true });

    await expect(page.getByText(/short idea first/i)).toBeVisible();
    expect(apiCalled).toBe(false);
  });

  test('populates prompt + negative on a successful assistant call (stubbed)', async ({
    page,
    request,
  }) => {
    // Stub the assistant response deterministically (no real model / GPU).
    await page.route(ASSISTANT_URL, (route) => {
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'prompt_e2e', status: 'queued' }),
      });
    });
    await page.route('**/api/image/prompt/assistant/prompt_e2e', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: 'prompt_e2e',
          status: 'completed',
          prompt: 'A refined, detailed prompt from the assistant',
          negativePrompt: 'blurry, low quality, watermark',
        }),
      });
    });

    await signInWithMagicLink(page, request, {
      email: 'e2e-prompt-assistant@example.com',
      redirectPath: '/image-generate',
    });

    const idea = page.getByLabel(/Describe your idea/i);
    const assistButton = page.getByRole('button', { name: /Help generate prompt/i });
    const prompt = page.getByLabel('Describe your image');
    const negative = page.getByLabel(/Things to avoid/i);

    await idea.fill('a cozy coffee shop on a rainy evening');
    await assistButton.click({ force: true });

    // On success the generated pair lands in the (editable) prompt + negative
    // fields, the pending label clears, and the control re-enables for retry.
    await expect(prompt).toHaveValue('A refined, detailed prompt from the assistant');
    await expect(negative).toHaveValue('blurry, low quality, watermark');
    await expect(page.getByText('Generating prompt…')).toHaveCount(0);
    await expect(assistButton).toBeEnabled();

    // The LLM gate host must never leak into the client.
    const html = await page.content();
    expect(html).not.toMatch(/192\.168\.0\.62:8081/);
  });

  test('on a failed assistant call shows an error, leaves fields unchanged, and re-enables', async ({
    page,
    request,
  }) => {
    await page.route(ASSISTANT_URL, (route) => {
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The model service is temporarily unavailable.' }),
      });
    });

    await signInWithMagicLink(page, request, {
      email: 'e2e-prompt-assistant@example.com',
      redirectPath: '/image-generate',
    });

    const idea = page.getByLabel(/Describe your idea/i);
    const assistButton = page.getByRole('button', { name: /Help generate prompt/i });
    const prompt = page.getByLabel('Describe your image');

    // Pre-fill the prompt so we can prove a failure does NOT clobber it.
    await prompt.fill('My existing prompt must survive');
    await idea.fill('a cozy coffee shop');
    await assistButton.click({ force: true });

    await expect(
      page.getByRole('alert').filter({ hasText: 'The model service is temporarily unavailable.' })
    ).toHaveText('The model service is temporarily unavailable.');
    await expect(prompt).toHaveValue('My existing prompt must survive');
    await expect(assistButton).toBeEnabled();
  });
});
