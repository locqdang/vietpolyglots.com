const { test, expect } = require('@playwright/test');
const { signInWithMagicLink } = require('./helpers/route-auth');

test.describe('Services → Image Generate', () => {
  test('redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/image-generate');

    await page.waitForURL('**/login?redirect=*');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fimage-generate$/);
  });

  test('includes an Image Generate entry in the Services navigation', async ({ page }) => {
    await page.goto('/');
    // The entry is Strapi-driven and can be labelled "Generate Image" or
    // "Image Generate". Assert the route exists without relying on hover timing.
    const servicesDropdown = page.locator('.nav__dropdown').filter({
      has: page.getByRole('button', { name: 'Services' }),
    });
    await expect(servicesDropdown.locator('a[href="/image-generate"]')).toHaveCount(1);
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
    await generateButton.click({ force: true });

    // No consent → blocked client-side, no API call, no generation.
    await expect(page.getByText(/confirm you understand the notice/i)).toBeVisible();
    await expect(page.locator('.image-generate__bar')).toHaveCount(0);
  });

  test('keeps a queued image job active until the server reports completion', async ({
    page,
    request,
  }) => {
    let polls = 0;
    await page.route('**/api/image/generate/history*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [], total: 0, page: 1 }),
      })
    );
    await page.route('**/api/image/generate', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'img_wait_e2e', status: 'queued' }),
      });
    });
    await page.route('**/api/image/generate/img_wait_e2e', (route) => {
      polls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          polls < 3
            ? { jobId: 'img_wait_e2e', status: 'queued' }
            : {
                jobId: 'img_wait_e2e',
                status: 'completed',
                image: 'data:image/png;base64,iVBORw0KGgo=',
                prompt: 'A watercolor red dragon',
                seed: 42,
              }
        ),
      });
    });
    await signInWithMagicLink(page, request, {
      email: 'e2e-image-generate@example.com',
      redirectPath: '/image-generate',
    });

    await page.getByLabel('Describe your image').fill('A watercolor red dragon');
    await page.getByLabel(/I have read and agree/).check({ force: true });
    await page.getByRole('button', { name: 'Generate image' }).click({ force: true });
    await expect(page.locator('.image-generate__bar')).toBeVisible();
    await expect(page.locator('.image-generate__img')).toBeVisible({ timeout: 15_000 });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(await page.content()).not.toMatch(/192\.168\.0\.62:8189/);
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

    await generateButton.click({ force: true });

    await expect(page.getByText('Please describe the image you want to create.')).toBeVisible();
    expect(apiCalled).toBe(false);
  });
});
