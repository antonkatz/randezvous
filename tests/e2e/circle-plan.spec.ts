import { expect, test, type Page } from '@playwright/test';

async function setName(page: Page, name: string): Promise<void> {
  await page.locator('#code-name').fill(name);
  await page.locator('#code-name').blur();
}

async function link(ana: Page, baz: Page): Promise<void> {
  await ana.goto('/');
  await setName(ana, 'Ana');
  await baz.goto('/');
  await setName(baz, 'Baz');
  await ana.waitForTimeout(250);
  await ana.getByRole('button', { name: 'add human' }).click();
  await ana.waitForFunction(() => {
    const root = document.querySelector('rendezvous-app')?.shadowRoot;
    return Boolean(root?.querySelector<HTMLInputElement>('#invite-link')?.value.startsWith('http'));
  });
  const linkUrl = await ana.locator('#invite-link').inputValue();
  await ana.locator('#invite-close').click();
  await baz.goto(linkUrl);
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect(baz.locator('#humans-list')).toContainText('Ana');
  await expect(ana.locator('#humans-list')).toContainText('here now');
  await expect(baz.locator('#humans-list')).toContainText('here now');
}

function localInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test('a circle sets a canonical plan and an optional window, and invitations auto-accept', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await link(ana, baz);

  const bar = ana.locator('circle-bar');
  await bar.getByRole('button', { name: 'Create a circle' }).click();
  const form = ana.locator('circle-create-form');
  await form.locator('input[name="name"]').fill('Moon Garden');
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();
  await expect(ana.locator('circle-stats-page')).toContainText('Moon Garden');

  const planMoment = new Date(Date.now() + 24 * 60 * 60_000);
  planMoment.setSeconds(0, 0);
  await ana.locator('#circle-plan-at').fill(localInput(planMoment));
  await ana.getByRole('button', { name: 'set circle rendezvous' }).click();
  await expect(ana.locator('.circle-plan .canonical-plan')).toContainText('next ·');
  await expect(ana.locator('.circle-plan .canonical-plan')).toContainText('by');

  const windowStart = new Date(planMoment.getTime() + 60 * 60_000);
  const windowEnd = new Date(planMoment.getTime() + 4 * 60 * 60_000);
  await ana.locator('#circle-window-start').fill(localInput(windowStart));
  await ana.locator('#circle-window-end').fill(localInput(windowEnd));
  await ana.getByRole('button', { name: 'set window' }).click();
  await expect(ana.locator('.circle-window .canonical-plan')).toContainText('active ·');

  // A plan outside the active window is refused before signing.
  const outside = new Date(planMoment.getTime() + 8 * 60 * 60_000);
  await ana.locator('#circle-plan-at').fill(localInput(outside));
  await ana.getByRole('button', { name: 'set circle rendezvous' }).click();
  await expect(ana.locator('#toast-region')).toContainText(/outside the circle/iu);
  await expect(ana.locator('.circle-plan .canonical-plan')).toContainText('next ·');

  // Inviting Baz auto-accepts on his side without a join click.
  await ana.getByRole('button', { name: 'invite' }).click();
  await expect(
    baz.locator('circle-bar').getByRole('button', { name: 'Moon Garden' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(ana.locator('circle-stats-page')).toContainText('/ 2', { timeout: 20_000 });

  // Both members converge on the same canonical plan.
  await baz.locator('circle-bar').getByRole('button', { name: 'Moon Garden' }).click();
  await expect(baz.locator('.circle-plan .canonical-plan')).toContainText('next ·');
  await expect(baz.locator('.circle-plan .canonical-plan')).toContainText('by');
  await expect(baz.locator('.circle-window .canonical-plan')).toContainText('active ·');

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});

test('an offline member receives the expiring circle rendezvous invite on reconnect', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  let baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await link(ana, baz);
  const bar = ana.locator('circle-bar');
  await bar.getByRole('button', { name: 'Create a circle' }).click();
  const form = ana.locator('circle-create-form');
  await form.locator('input[name="name"]').fill('Night Orchard');
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();
  await expect(ana.locator('circle-stats-page')).toContainText('Night Orchard');
  await ana.getByRole('button', { name: 'invite' }).click();
  await expect(
    baz.locator('circle-bar').getByRole('button', { name: 'Night Orchard' }),
  ).toBeVisible({ timeout: 20_000 });

  // Baz goes offline before the plan is signed, so only the server can carry it.
  await baz.close();
  await expect
    .poll(async () => ana.locator('#humans-list').innerText(), { timeout: 15_000 })
    .toContain('away');

  const planMoment = new Date(Date.now() + 2 * 24 * 60 * 60_000);
  planMoment.setSeconds(0, 0);
  await ana.locator('#circle-plan-at').fill(localInput(planMoment));
  await ana.getByRole('button', { name: 'set circle rendezvous' }).click();
  await expect(ana.locator('.circle-plan .canonical-plan')).toContainText('next ·');
  await ana.close();

  baz = await bazContext.newPage();
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));
  await baz.goto('/');
  await expect(baz.locator('#humans-list')).toContainText('Ana');
  await baz
    .locator('circle-bar')
    .getByRole('button', { name: 'Night Orchard' })
    .click({ timeout: 20_000 });
  await expect(baz.locator('.circle-plan .canonical-plan')).toContainText('next ·', {
    timeout: 20_000,
  });
  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});
