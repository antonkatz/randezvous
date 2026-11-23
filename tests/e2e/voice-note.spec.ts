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
          humans: Array<{ id: string; name: string }>;
          rendezvous: Array<{
            id: string;
            status: string;
            photo: {
              photoId: string;
              note: { durationMs: number; type: string } | null;
            } | null;
          }>;
          prints: Array<{
            id: string;
            photoId: string;
            direction: string;
            photo: {
              note: { durationMs: number } | null;
            };
          }>;
        };
      };
    };
    return app.clientInstance.getSnapshot();
  });
}

test('a voice note travels with the photo and follows a local re-share', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
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
            note: {
              blob: Blob;
              name: string;
              type: string;
              size: number;
              durationMs: number;
            };
            scheduledFor: number;
          }) => Promise<{ id: string; photo: { photoId: string } }>;
        };
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 800));
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const noteBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      const photo = new File([bytes], 'noted.png', { type: 'image/png' });
      const record = await app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo,
        note: {
          blob: noteBlob,
          name: 'voice-note.webm',
          type: noteBlob.type,
          size: noteBlob.size,
          durationMs: 800,
        },
        scheduledFor: Date.now() + 6 * 60_000,
      });
      return { id: record.id, photoId: record.photo.photoId };
    },
    { humanId: humanId! },
  );

  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.id, { timeout: 15_000 })
    .toBe(scheduled.id);
  await ana.clock.install();
  await baz.clock.install();
  await ana.clock.fastForward(6 * 60_000);
  await baz.clock.fastForward(6 * 60_000);
  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.status, { timeout: 40_000 })
    .toBe('delivered');

  const received = (await snapshot(baz)).rendezvous[0];
  expect(received?.photo?.photoId).toBe(scheduled.photoId);
  expect(received?.photo?.note?.durationMs).toBeGreaterThanOrEqual(700);
  const receivedPrint = (await snapshot(baz)).prints.find(
    (print) => print.photoId === scheduled.photoId && print.direction === 'incoming',
  );
  expect(receivedPrint?.photo.note?.durationMs).toBeGreaterThanOrEqual(700);
  await expect(baz.locator('.wall-note-badge')).toBeVisible();
  await expect(baz.locator('.wall-note-badge')).toContainText('0:01');

  await baz.locator('.wall-photo', { hasText: 'from Ana' }).first().click();
  await expect(baz.locator('#viewer-note')).toBeVisible();
  await expect(baz.locator('#viewer-note-audio')).toHaveAttribute('src', /^blob:/u);
  const paused = await baz.locator('#viewer-note-audio').evaluate((element) => {
    const audio = element as HTMLAudioElement;
    return audio.paused;
  });
  expect(paused).toBe(true);
  await baz.locator('#photo-viewer-close').click();

  // Wait for the live screen to leave, then re-share the outgoing print.
  await ana.waitForTimeout(1_800);
  await ana.locator('.wall-photo', { hasText: 'to Baz' }).first().click();
  await ana.locator('#photo-share').click();
  await expect(ana.locator('#rv-title')).toHaveText('Share again');
  await expect(ana.locator('#photo-preview')).toBeVisible();
  await expect(ana.locator('#composer-note-attached')).toBeVisible();
  await expect(ana.locator('#composer-note-audio')).toHaveAttribute('src', /^blob:/u);
  await ana.locator('.human-option').first().click();
  await ana.locator('#rv-next').click();
  const target = await ana.evaluate(() => {
    const date = new Date(Date.now() + 5 * 60_000);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return {
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    };
  });
  await ana.locator('#rv-date').fill(target.date);
  await ana.locator('#rv-time').fill(target.time);
  await ana.locator('#rv-time').dispatchEvent('input');
  await expect(ana.locator('#rv-schedule')).toBeEnabled();
  await ana.locator('#rv-schedule').click();
  await expect(ana.locator('#rv-step-3')).toBeVisible();

  await expect
    .poll(async () => (await snapshot(baz)).prints.length, { timeout: 40_000 })
    .toBeGreaterThanOrEqual(2);
  const reshared = (await snapshot(baz)).prints.find(
    (print) => print.direction === 'incoming' && print.photoId === scheduled.photoId,
  );
  expect(reshared?.photo.note?.durationMs).toBeGreaterThanOrEqual(700);

  // Deleting the new print never deletes the source or the original share.
  const before = (await snapshot(baz)).prints.length;
  await baz.evaluate(async ({ printId }) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { deletePrint: (id: string) => Promise<void> };
    };
    await app.clientInstance.deletePrint(printId!);
  }, { printId: reshared!.id });
  await expect
    .poll(async () => (await snapshot(baz)).prints.length)
    .toBe(before - 1);
  expect(
    (await snapshot(baz)).prints.some((print) => print.photoId === scheduled.photoId),
  ).toBe(true);

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
});
