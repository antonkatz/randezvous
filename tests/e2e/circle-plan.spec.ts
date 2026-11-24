import { expect, test, type Page } from '@playwright/test';
import { linkPages, TINY_PNG } from './helpers';

async function createCircle(page: Page, name: string): Promise<void> {
  const bar = page.locator('circle-bar');
  await bar.getByRole('button', { name: 'Create a circle' }).click();
  const form = page.locator('circle-create-form');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();
  await expect(page.locator('circle-stats-page')).toContainText(name);
}

async function setCircleRendezvous(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'set a circle rendezvous' }).click();
  await expect(page.locator('#rendezvous-dialog')).toHaveAttribute('open', '');
  await expect(page.locator('.human-option.is-circle input')).toBeChecked();
  await page.locator('#photo-input').setInputFiles({
    name: 'circle-meeting.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await expect(page.locator('#rv-next')).toBeEnabled();
  await page.locator('#rv-next').click();
  await expect(page.locator('#rv-schedule')).toBeEnabled();
  await page.locator('#rv-schedule').click();
  await expect(page.locator('#rv-step-3')).toBeVisible();
  await page.locator('#rv-finish').click();
}

async function fastForwardMeeting(pages: Page[]): Promise<void> {
  for (const page of pages) await page.clock.install();
  for (const page of pages) await page.clock.fastForward(2 * 60 * 60_000);
}

test('a circle rendezvous uses the normal rendezvous mechanism', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await linkPages(ana, baz);
  await createCircle(ana, 'Moon Garden');
  await ana.locator('button[data-invite-key]').first().click();
  await expect(
    baz.locator('circle-bar').getByRole('button', { name: 'Moon Garden' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(ana.locator('circle-stats-page')).toContainText('/ 2', { timeout: 20_000 });

  await setCircleRendezvous(ana);
  await expect
    .poll(
      async () =>
        baz.evaluate(() => {
          const app = document.querySelector('rendezvous-app') as unknown as {
            clientInstance: { getSnapshot: () => { rendezvous: Array<{ circleId: string | null }> } };
          };
          return app.clientInstance.getSnapshot().rendezvous.find((entry) => entry.circleId);
        }),
      { timeout: 15_000 },
    )
    .toBeTruthy();

  await fastForwardMeeting([ana, baz]);
  await expect
    .poll(
      async () =>
        ana.evaluate(() => {
          const app = document.querySelector('rendezvous-app') as unknown as {
            clientInstance: {
              getSnapshot: () => {
                rendezvous: Array<{ status: string; circleId: string | null; deliveredTo: string[] }>;
              };
            };
          };
          const record = app.clientInstance
            .getSnapshot()
            .rendezvous.find((entry) => entry.circleId);
          return record?.status;
        }),
      { timeout: 30_000 },
    )
    .toMatch(/kept|delivered/u);
  await expect(baz.locator('.wall-photo')).toHaveCount(1, { timeout: 30_000 });

  await ana.locator('circle-bar').getByRole('button', { name: 'Moon Garden' }).click();
  await expect(ana.locator('circle-stats-page')).toContainText(/kept|delivered/u);
  await expect(ana.locator('circle-stats-page')).toContainText('/ 2');

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});
