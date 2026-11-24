import { expect, test } from '@playwright/test';
import { setName } from './helpers';

function localInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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

test('a circle rendezvous link grants membership while the inviter is offline', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await ana.goto('/');
  await setName(ana, 'Ana');

  const bar = ana.locator('circle-bar');
  await bar.getByRole('button', { name: 'Create a circle' }).click();
  const form = ana.locator('circle-create-form');
  await form.locator('input[name="name"]').fill('Rendezvous Circle');
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();
  await expect(ana.locator('circle-stats-page')).toContainText('Rendezvous Circle');

  const moment = new Date(Date.now() + 24 * 60 * 60_000);
  moment.setSeconds(0, 0);
  await ana.locator('#circle-plan-at').fill(localInput(moment));
  await ana.getByRole('button', { name: 'offer a circle rendezvous' }).click();
  await expect(ana.locator('.circle-offer .canonical-plan')).toContainText('by');

  await ana.getByRole('button', { name: 'invite by link' }).click();
  await expect(ana.locator('#new-circle-link')).toHaveValue(/^http/u);
  const link = await ana.locator('#new-circle-link').inputValue();

  // The inviter is not needed to redeem the link.
  await anaContext.close();

  await baz.goto('/');
  await setName(baz, 'Baz');
  await baz.goto(link);

  await expect(baz.locator('#humans-list')).toContainText('Ana');
  const circle = baz.locator('circle-bar').getByRole('button', {
    name: 'Rendezvous Circle',
  });
  await expect(circle).toBeVisible({ timeout: 25_000 });
  await circle.click();

  await expect(baz.locator('circle-stats-page')).toContainText('Rendezvous Circle');
  await expect(baz.locator('.circle-offer .canonical-plan')).toContainText('by');
  await expect(baz.locator('.circle-offer .offer-state')).toContainText('confirmed');
  await expect(baz.locator('circle-stats-page')).toContainText('/ 2');

  expect(errors).toEqual([]);
  await bazContext.close();
});
