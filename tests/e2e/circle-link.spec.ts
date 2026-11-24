import { expect, test } from '@playwright/test';
import { setName } from './helpers';

test('a circle invitation link also creates the human link', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await ana.goto('/');
  await setName(ana, 'Ana');
  await expect(ana.locator('#add-human')).toHaveCount(0);

  const bar = ana.locator('circle-bar');
  await bar.getByRole('button', { name: 'Create a circle' }).click();
  const form = ana.locator('circle-create-form');
  await form.locator('input[name="name"]').fill('Link Circle');
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();
  await expect(ana.locator('circle-stats-page')).toContainText('Link Circle');

  await ana.getByRole('button', { name: 'invite someone new' }).click();
  await expect(ana.locator('#new-circle-link')).toHaveValue(/^http/u);
  const link = await ana.locator('#new-circle-link').inputValue();

  await baz.goto('/');
  await setName(baz, 'Baz');
  await baz.goto(link);

  await expect(baz.locator('#humans-list')).toContainText('Ana');
  await expect(
    baz.locator('circle-bar').getByRole('button', { name: 'Link Circle' }),
  ).toBeVisible({ timeout: 25_000 });
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect(ana.locator('circle-stats-page')).toContainText('/ 2', {
    timeout: 25_000,
  });

  await baz.locator('circle-bar').getByRole('button', { name: 'Link Circle' }).click();
  await expect(baz.locator('circle-stats-page')).toContainText('Link Circle');
  await expect(baz.locator('circle-stats-page')).toContainText('/ 2');

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});
