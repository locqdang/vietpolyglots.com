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
    const imageLink = servicesDropdown.getByRole('link', { name: 'Image Generate' });

    await servicesButton.click();
    await expect(imageLink).toBeVisible();
  });

  test('renders the form for a signed-in user and reaches a terminal state after submit', async ({
    page,
    request,
  }) => {
    await signInWithMagicLink(page, request, {
      email: 'e2e-image-generate@example.com',
      redirectPath: '/image-generate',
    });

    await expect(
      page.getByRole('heading', { name: 'Create an image from a description' })
    ).toBeVisible();

    const prompt = page.getByLabel('Describe your image');
    const generateButton = page.getByRole('button', { name: 'Generate image' });
    await expect(prompt).toBeVisible();
    await expect(generateButton).toBeEnabled();

    await prompt.fill('A watercolor red dragon flying over misty mountains at sunrise');
    await generateButton.click();

    // The generation runs on the GPU gate. Whether the gate is up or down, the page
    // must reach a terminal state (image rendered, or a clear error) without hanging.
    const terminal = page.locator('.image-generate__img, .image-generate__errorbox');
    await expect(terminal.first()).toBeVisible({ timeout: 150_000 });

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
      if (req.url().includes('/api/image/generate')) {
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
