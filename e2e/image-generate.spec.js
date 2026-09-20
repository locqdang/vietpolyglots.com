const { test, expect } = require('@playwright/test');
const { signInWithMagicLink } = require('./helpers/route-auth');

test.describe('Services → Image Generate', () => {
  test('redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/image-generate');

    await page.waitForURL('**/login?redirect=*');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fimage-generate$/);
  });

  test('shows an Image Generate entry in the Services dropdown', async ({ page }) => {
    await page.goto('/');

    const servicesButton = page.getByRole('button', { name: 'Services' });
    const servicesDropdown = page.locator('.nav__dropdown').filter({ has: servicesButton });
    // The Services menu is Strapi-driven; the live entry is labelled "Generate
    // Image" (the code fallback says "Image Generate"). Match on the URL so the
    // test is resilient to the label wording.
    const imageLink = servicesDropdown.locator('a[href="/image-generate"]');

    await servicesButton.click();
    await expect(imageLink).toBeVisible();
  });

  test('blocks submission until the legal notice is accepted', async ({ page, request }) => {
    await signInWithMagicLink(page, request, {
      email: 'e2e-image-generate@example.com',
      redirectPath: '/image-generate',
    });

    const prompt = page.getByLabel('Describe your image');
    const generateButton = page.getByRole('button', { name: 'Generate image' });
    const consent = page.getByLabel(/I have read and agree/);
    await expect(prompt).toBeVisible();
    await expect(consent).toBeVisible();

    await prompt.fill('A watercolor red dragon');
    await generateButton.click();

    // No consent → blocked client-side, no API call, no generation.
    await expect(page.getByText(/confirm you understand the notice/i)).toBeVisible();
    await expect(page.locator('.image-generate__bar')).toHaveCount(0);
  });

  test('reaches a terminal state after submit once consent is given', async ({ page, request }) => {
    // The page's poll cap is 420s; allow margin for login + queue wait behind the
    // shared-GPU LLM. Playwright's default per-test timeout (30s) would cut this
    // off far too early.
    test.setTimeout(480_000);

    await signInWithMagicLink(page, request, {
      email: 'e2e-image-generate@example.com',
      redirectPath: '/image-generate',
    });

    const prompt = page.getByLabel('Describe your image');
    const generateButton = page.getByRole('button', { name: 'Generate image' });
    const consent = page.getByLabel(/I have read and agree/);
    await expect(prompt).toBeVisible();
    await expect(consent).toBeVisible();

    await prompt.fill('A watercolor red dragon flying over misty mountains at sunrise');
    await consent.check();
    await generateButton.click();

    // The job is queued, then the page polls. The progress bar must appear while
    // in flight.
    await expect(page.locator('.image-generate__bar')).toBeVisible();

    // The generation runs on the shared GPU gate, which the 27B LLM also uses.
    // When the LLM holds the GPU, the image job queues behind it (can be 100–300s),
    // so the page may sit in "queued" before rendering. The page guarantees a
    // terminal state (image, error, or poll-timeout error) within its 420s poll
    // cap, so wait past that — the assertion is "reaches a terminal state without
    // hanging", not "renders fast".
    const terminal = page.locator('.image-generate__img, .image-generate__errorbox');
    await expect(terminal.first()).toBeVisible({ timeout: 450_000 });

    // Gate/ComfyUI host must never leak into the client.
    const html = await page.content();
    expect(html).not.toMatch(/192\.168\.0\.62:8189/);
  });

  test('shows a client-side validation message for an empty prompt (no request sent)', async ({
    page,
    request,
  }) => {
    let apiCalled = false;
    page.on('request', (req) => {
      // Only the generation submit is a POST to /api/image/generate. The page
      // also makes GETs to /api/image/generate/quota and /history on mount, so
      // match on method to avoid counting those.
      if (req.method() === 'POST' && req.url().includes('/api/image/generate')) {
        apiCalled = true;
      }
    });

    await signInWithMagicLink(page, request, {
      email: 'e2e-image-generate@example.com',
      redirectPath: '/image-generate',
    });

    const prompt = page.getByLabel('Describe your image');
    const generateButton = page.getByRole('button', { name: 'Generate image' });
    await expect(prompt).toBeVisible();

    await generateButton.click();

    await expect(page.getByText('Please describe the image you want to create.')).toBeVisible();
    expect(apiCalled).toBe(false);
  });
});
