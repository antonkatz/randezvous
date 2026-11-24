import { expect, test } from '@playwright/test';

test('the circle bar creates, selects, and marks the active circle', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveClass(/is-loading/u);

  const bar = page.locator('circle-bar');
  await expect(bar).toBeVisible();
  await page.waitForTimeout(500);
  const dockBox = await bar.boundingBox();
  const viewport = page.viewportSize();
  expect(dockBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(dockBox!.x + dockBox!.width).toBeGreaterThan(viewport!.width - 40);
  const create = bar.getByRole('button', { name: 'Create a circle' });
  await expect(create).toBeVisible();

  const shape = await create.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      radius: getComputedStyle(button).borderRadius,
    };
  });
  expect(shape.width).toBe(shape.height);
  expect(shape.width).toBeGreaterThanOrEqual(44);
  expect(shape.radius).toBe('50%');

  await create.click();
  const dialog = page.locator('#circle-dialog');
  await expect(dialog).toBeVisible();

  const form = dialog.locator('circle-create-form');
  await form.locator('input[name="name"]').fill('Sunday table');
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();

  const circle = bar.getByRole('button', { name: 'Sunday table' });
  await expect(circle).toBeVisible();
  await expect(circle).toHaveAttribute('aria-current', 'true');

  await page.locator('#circle-close').click();
  await expect(dialog).not.toBeVisible();
  await circle.click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Sunday table');
  await expect(circle).toHaveAttribute('aria-current', 'true');
});
