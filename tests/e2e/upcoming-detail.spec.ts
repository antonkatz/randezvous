import { expect, test } from '@playwright/test';
import { linkPages, TINY_PNG } from './helpers';

test('an upcoming rendezvous opens the exchange detail, not the verification panel', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const bazContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  await linkPages(ana, baz);

  const setFromHumans = ana.locator('#humans-set-rendezvous');
  await expect(setFromHumans).toBeVisible();
  const setBox = await setFromHumans.boundingBox();
  const humanListBox = await ana.locator('#humans-list').boundingBox();
  expect(setBox).not.toBeNull();
  expect(humanListBox).not.toBeNull();
  expect(setBox!.y).toBeLessThan(humanListBox!.y);
  await setFromHumans.click();
  await expect(ana.locator('#rendezvous-dialog')).toHaveAttribute('open', '');
  await ana.locator('#rv-close').click();

  const humanId = await ana.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { getSnapshot: () => { humans: Array<{ id: string }> } };
    };
    return app.clientInstance.getSnapshot().humans[0]?.id;
  });
  expect(humanId).toBeTruthy();

  const appointmentId = await ana.evaluate(
    async ({ humanId, encoded }) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const photo = new File([bytes], 'upcoming-detail.png', { type: 'image/png' });
      const app = document.querySelector('rendezvous-app') as unknown as {
        clientInstance: {
          scheduleRendezvous: (input: {
            humanId: string;
            photo: File;
            fileName: string;
            scheduledFor: number;
          }) => Promise<{ id: string }>;
        };
      };
      const record = await app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo,
        fileName: photo.name,
        scheduledFor: Date.now() + 10 * 60_000,
      });
      return record.id;
    },
    { humanId: humanId!, encoded: TINY_PNG.toString('base64') },
  );

  await expect(ana.locator('.next-card')).toBeVisible();
  await expect(ana.locator('#set-rendezvous')).toBeHidden();
  await expect(setFromHumans).toBeVisible();
  await ana.locator('.next-card').first().click();

  const detail = ana.locator('#rendezvous-detail-dialog');
  await expect(detail).toHaveAttribute('open', '');
  await expect(ana.locator('#human-dialog')).not.toBeVisible();
  await expect(ana.locator('#rv-detail-title')).toContainText('Baz');
  await expect(ana.locator('#rv-detail-photo')).toHaveAttribute('src', /^blob:/u);
  await expect(ana.locator('#rv-detail-photo-state')).toContainText(/your photo · added/iu);
  await expect(ana.locator('#rv-detail-peer-state')).toContainText(/waiting/iu);
  await expect(ana.locator('#rv-detail-verify-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(ana.locator('#rv-detail-verify-panel')).toBeHidden();
  await expect(ana.locator('#rv-detail-verification-words li')).toHaveCount(0);

  await ana.locator('#rv-detail-verify-toggle').click();
  await expect(ana.locator('#rv-detail-verify-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(ana.locator('#rv-detail-verification-words li')).toHaveCount(8);
  await ana.locator('#rv-detail-mark-verified').click();
  await expect(ana.locator('#rv-detail-verify-badge')).toHaveText('verified');

  await ana.locator('#rv-detail-close').click();
  await expect(detail).not.toBeVisible();
  await expect(ana.locator('#set-rendezvous')).toBeHidden();

  await ana.evaluate(async (id) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { deleteRendezvous: (value: string) => Promise<void> };
    };
    await app.clientInstance.deleteRendezvous(id);
  }, appointmentId);
  await expect(ana.locator('#set-rendezvous')).toBeVisible();

  await anaContext.close();
  await bazContext.close();
});
