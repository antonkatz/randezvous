import { expect, test, type Page } from '@playwright/test';
import { linkPages } from './helpers';

interface RecordView {
  id: string;
  scheduledFor: number;
  confirmation: 'pending' | 'confirmed';
  confirmedBy: string[];
  proposedBy: string;
  revision: number;
  status: string;
  photo: { size: number } | null;
  participants?: Array<{ id: string; name: string }>;
  creatorId?: string;
}

async function recordFor(page: Page, id: string): Promise<RecordView | undefined> {
  return page.evaluate((rendezvousId) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => { rendezvous: RecordView[] };
      };
    };
    return app.clientInstance
      .getSnapshot()
      .rendezvous.find((entry) => entry.id === rendezvousId);
  }, id);
}

async function confirm(page: Page, id: string): Promise<void> {
  await page.evaluate(async (rendezvousId) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { confirmRendezvous: (value: string) => Promise<unknown> };
    };
    await app.clientInstance.confirmRendezvous(rendezvousId);
  }, id);
}

test('both humans confirm, then a counter-proposal creates another rendezvous', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await linkPages(ana, baz);

  const scheduledFor = Date.now() + 10 * 60_000;
  const created = await ana.evaluate(
    async ({ scheduledFor: when }) => {
      const app = document.querySelector('rendezvous-app') as unknown as {
        clientInstance: {
          getSnapshot: () => { humans: Array<{ id: string }> };
          scheduleRendezvous: (input: {
            humanId: string;
            photo: File;
            fileName: string;
            scheduledFor: number;
          }) => Promise<{ id: string; confirmation: string; photo: { size: number } | null }>;
        };
      };
      const humanId = app.clientInstance.getSnapshot().humans[0]?.id;
      if (!humanId) throw new Error('human missing');
      const file = new File([Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      )], 'counter.png', { type: 'image/png' });
      return app.clientInstance.scheduleRendezvous({
        humanId,
        photo: file,
        fileName: file.name,
        scheduledFor: when,
      });
    },
    { scheduledFor },
  );

  await expect
    .poll(async () => (await recordFor(baz, created.id))?.confirmation, { timeout: 20_000 })
    .toBe('pending');
  await expect(baz.locator('.next-card-confirmation')).toContainText('pending');
  expect((await recordFor(baz, created.id))?.photo).toBeNull();
  await baz.locator('.next-card').first().click();
  await expect(baz.locator('#rv-detail-confirmation')).toContainText('pending');
  await expect(baz.locator('#rv-detail-confirm')).toBeVisible();
  await baz.locator('#rv-detail-close').click();

  await confirm(baz, created.id);
  await expect
    .poll(async () => (await recordFor(ana, created.id))?.confirmedBy.length, {
      timeout: 20_000,
    })
    .toBe(1);
  expect((await recordFor(ana, created.id))?.confirmation).toBe('pending');

  await confirm(ana, created.id);
  await expect
    .poll(async () => (await recordFor(ana, created.id))?.confirmation, { timeout: 20_000 })
    .toBe('confirmed');
  await expect
    .poll(async () => (await recordFor(baz, created.id))?.confirmation, { timeout: 20_000 })
    .toBe('confirmed');

  const proposed = scheduledFor + 60 * 60_000;
  const nextId = await baz.evaluate(
    async ({ id, when }) => {
      const app = document.querySelector('rendezvous-app') as unknown as {
        clientInstance: {
          counterProposeRendezvous: (input: {
            rendezvousId: string;
            scheduledFor: number;
          }) => Promise<{ id: string }>;
        };
      };
      const next = await app.clientInstance.counterProposeRendezvous({
        rendezvousId: id,
        scheduledFor: when,
      });
      return next.id;
    },
    { id: created.id, when: proposed },
  );
  expect(nextId).not.toBe(created.id);

  // The original is untouched and stays confirmed.
  expect((await recordFor(ana, created.id))?.scheduledFor).toBe(scheduledFor);
  expect((await recordFor(ana, created.id))?.confirmation).toBe('confirmed');
  expect((await recordFor(ana, created.id))?.photo?.size).toBe(created.photo?.size);

  // The new rendezvous is independent, pending, and reaches every participant.
  await expect
    .poll(async () => (await recordFor(ana, nextId))?.scheduledFor, { timeout: 20_000 })
    .toBe(proposed);
  expect((await recordFor(ana, nextId))?.confirmation).toBe('pending');
  expect((await recordFor(ana, nextId))?.participants?.length).toBe(2);

  await confirm(ana, nextId);
  await confirm(baz, nextId);
  await expect
    .poll(async () => (await recordFor(ana, nextId))?.confirmation, { timeout: 20_000 })
    .toBe('confirmed');
  await expect
    .poll(async () => (await recordFor(baz, nextId))?.confirmation, { timeout: 20_000 })
    .toBe('confirmed');

  expect((await recordFor(baz, created.id))?.scheduledFor).toBe(scheduledFor);
  expect((await recordFor(baz, created.id))?.confirmation).toBe('confirmed');

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});
