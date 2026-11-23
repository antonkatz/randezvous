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

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          identity: { id: string; name: string };
          humans: Array<{ id: string; name: string }>;
          rendezvous: Array<{
            id: string;
            direction: string;
            scheduledFor: number;
            status: string;
            photo: { photoId: string; size: number; note: { durationMs: number } | null } | null;
            contribution: { photoId: string; size: number } | null;
            reciprocal: { photoId: string; size: number } | null;
          }>;
          prints: Array<{
            id: string;
            appointmentId: string;
            photoId: string;
            direction: string;
            peerName: string;
            photo: { note: { durationMs: number } | null };
          }>;
          possessions: Array<{
            photoId: string;
            holder: string;
            state: string;
            online: boolean;
            connected: boolean;
            confirmedNow: boolean;
          }>;
        };
      };
    };
    return app.clientInstance.getSnapshot();
  });
}

async function makePhoto(page: Page, colour: string, name: string): Promise<{ size: number }> {
  return page.evaluate(
    async ({ colour, name }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 420;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No canvas');
      context.fillStyle = colour;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#faf6ed';
      context.font = '48px serif';
      context.fillText(name, 40, 220);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('No blob'))), 'image/png');
      });
      return { size: blob.size, key: `${colour}-${name}` };
    },
    { colour, name },
  );
}

test('exchange is reciprocal, independent, and reports possession', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  await ana.clock.install();
  await baz.clock.install();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await link(ana, baz);
  const humanId = (await snapshot(ana)).humans[0]?.id;
  expect(humanId).toBeTruthy();

  const scheduled = await ana.evaluate(
    async ({ humanId }) => {
      const app = document.querySelector('rendezvous-app') as unknown as {
        clientInstance: {
          scheduleRendezvous: (input: {
            humanId: string;
            photo: File;
            scheduledFor: number;
          }) => Promise<{ id: string }>;
        };
      };
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 480;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No canvas');
      context.fillStyle = '#b6492f';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('No blob'))), 'image/png');
      });
      const file = new File([blob], 'ana.png', { type: 'image/png' });
      const record = await app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo: file,
        scheduledFor: Date.now() + 6 * 60_000,
      });
      return { id: record.id, size: blob.size };
    },
    { humanId: humanId! },
  );

  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.id, { timeout: 15_000 })
    .toBe(scheduled.id);

  const before = await snapshot(baz);
  const bazRecordId = before.rendezvous[0]?.id;
  const contribution = await baz.evaluate(
    async ({ rendezvousId }) => {
      const app = document.querySelector('rendezvous-app') as unknown as {
        clientInstance: {
          setContribution: (input: {
            rendezvousId: string;
            photo: File;
          }) => Promise<unknown>;
        };
      };
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 400;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No canvas');
      context.fillStyle = '#3f6d5a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('No blob'))), 'image/png');
      });
      const file = new File([blob], 'baz.png', { type: 'image/png' });
      await app.clientInstance.setContribution({ rendezvousId: rendezvousId!, photo: file });
      return { size: blob.size };
    },
    { rendezvousId: bazRecordId! },
  );

  await ana.clock.fastForward(6 * 60_000);
  await baz.clock.fastForward(6 * 60_000);

  await expect
    .poll(async () => (await snapshot(ana)).rendezvous[0]?.status, { timeout: 40_000 })
    .toBe('delivered');
  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.status, { timeout: 40_000 })
    .toBe('delivered');
  await expect
    .poll(
      async () => (await snapshot(ana)).prints.length,
      { timeout: 40_000 },
    )
    .toBe(2);
  await expect
    .poll(
      async () => (await snapshot(baz)).prints.length,
      { timeout: 40_000 },
    )
    .toBe(2);

  const anaSnapshot = await snapshot(ana);
  const bazSnapshot = await snapshot(baz);
  expect(anaSnapshot.rendezvous[0]?.photo?.size).toBe(scheduled.size);
  expect(anaSnapshot.rendezvous[0]?.reciprocal?.size).toBe(contribution.size);
  expect(bazSnapshot.rendezvous[0]?.photo?.size).toBe(scheduled.size);
  expect(bazSnapshot.rendezvous[0]?.contribution?.size).toBe(contribution.size);
  expect(anaSnapshot.prints.map((print) => print.direction).sort()).toEqual([
    'incoming',
    'outgoing',
  ]);
  expect(bazSnapshot.prints.map((print) => print.direction).sort()).toEqual([
    'incoming',
    'outgoing',
  ]);

  const anaPhotoId = anaSnapshot.rendezvous[0]?.photo?.photoId;
  expect(anaPhotoId).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await snapshot(ana)).possessions.find(
          (entry) => entry.photoId === anaPhotoId && entry.state === 'held',
        )?.holder,
      { timeout: 20_000 },
    )
    .toBe((await snapshot(baz)).identity.id);

  const receivedPrint = (await snapshot(baz)).prints.find(
    (print) => print.photoId === anaPhotoId && print.direction === 'incoming',
  );
  expect(receivedPrint).toBeTruthy();
  await baz.evaluate(async ({ printId }) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { deletePrint: (id: string) => Promise<void> };
    };
    await app.clientInstance.deletePrint(printId!);
  }, { printId: receivedPrint!.id });

  await expect
    .poll(
      async () =>
        (await snapshot(ana)).possessions.find((entry) => entry.photoId === anaPhotoId)?.state,
      { timeout: 20_000 },
    )
    .toBe('released');

  await expect(baz.locator('.wall-photo')).toHaveCount(1);
  await ana.locator('.wall-photo', { hasText: 'to Baz' }).first().click();
  await expect(ana.locator('#viewer-possession')).toBeVisible();
  await expect(ana.locator('#possession-list')).toContainText('deleted');
  await ana.locator('#photo-viewer-close').click();

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});
