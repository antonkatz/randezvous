import { expect, test, type Page } from '@playwright/test';
import { linkPages, TINY_PNG } from './helpers';

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          humans: Array<{ id: string; online: boolean }>;
          rendezvous: Array<{
            id: string;
            status: string;
            audioWindowUsedAt: number | null;
            liveAudioDisabled: boolean;
            scheduledFor: number;
          }>;
          audio: {
            phase: string;
            muted: boolean;
            remoteMuted: boolean;
            remainingMs: number;
            rendezvousId: string | null;
          };
        };
      };
    };
    return app.clientInstance.getSnapshot();
  });
}

test('one-minute voice needs both people, consumes once, and never blocks photos', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await linkPages(ana, baz);
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
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      const file = new File([bytes], 'voice-meeting.png', { type: 'image/png' });
      const record = await app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo: file,
        scheduledFor: Date.now() + 6 * 60_000,
      });
      return { id: record.id };
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

  await expect(ana.locator('#live-dialog')).toHaveAttribute('open', '');
  await expect(baz.locator('#live-dialog')).toHaveAttribute('open', '');
  await expect(ana.locator('#live-start-audio')).toContainText('start audio 1min');

  // Declining does not consume the single window.
  await ana.locator('#live-start-audio').click();
  await expect(baz.locator('#live-consent')).toBeVisible();
  await baz.locator('#live-not-now').click();
  await expect.poll(async () => (await snapshot(ana)).audio.phase).toBe('declined');
  expect((await snapshot(ana)).rendezvous[0]?.audioWindowUsedAt).toBeNull();

  // The next request can be accepted by both sides.
  await ana.locator('#live-start-audio').click();
  await expect(baz.locator('#live-consent')).toBeVisible();
  await baz.locator('#live-allow').click();
  await expect
    .poll(async () => (await snapshot(ana)).audio.phase, { timeout: 25_000 })
    .toBe('live');
  await expect
    .poll(async () => (await snapshot(baz)).audio.phase, { timeout: 25_000 })
    .toBe('live');
  expect((await snapshot(ana)).rendezvous[0]?.audioWindowUsedAt).toBeTruthy();
  await expect(ana.locator('#live-countdown')).toHaveText(/^0:(?:5\d|4\d)$/u);

  await ana.locator('#live-mute').click();
  await expect
    .poll(async () => (await snapshot(baz)).audio.remoteMuted)
    .toBe(true);
  await expect(ana.locator('#live-mute')).toHaveText('unmute');

  await baz.locator('#live-end').click();
  await expect
    .poll(async () => (await snapshot(ana)).audio.phase, { timeout: 15_000 })
    .toBe('ended');
  await expect
    .poll(async () => (await snapshot(baz)).audio.phase, { timeout: 15_000 })
    .toBe('ended');
  await expect(ana.locator('#live-start-audio')).toBeDisabled();
  await expect(ana.locator('#live-start-audio')).toContainText('the minute is over');

  // The photo path completed independently of the audio window.
  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.status, { timeout: 30_000 })
    .toBe('delivered');
  await expect(baz.locator('.wall-photo')).toHaveCount(1);
  expect(errors).toEqual([]);

  await anaContext.close();
  await bazContext.close();
});

test('I won’t be able to speak disables live audio for both people without blocking photos', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));

  await linkPages(ana, baz);

  await ana.locator('#set-rendezvous').click();
  await ana.locator('#photo-input').setInputFiles({
    name: 'no-voice.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await ana.locator('.human-option').filter({ hasText: 'Baz' }).click();
  await expect(ana.locator('#rv-next')).toBeEnabled();
  await ana.locator('#rv-next').click();
  await expect(ana.locator('#rv-schedule')).toBeEnabled();
  await ana.locator('.speak-option').click();
  await expect(ana.locator('#rv-audio-disabled')).toBeChecked();
  await ana.locator('#rv-schedule').click();
  await expect(ana.locator('#rv-step-3')).toBeVisible();
  await expect(ana.locator('#done-audio-off')).toBeVisible();
  await ana.locator('#rv-finish').click();

  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.id, { timeout: 15_000 })
    .toBeTruthy();
  const appointmentId = (await snapshot(ana)).rendezvous[0]?.id;
  expect(appointmentId).toBeTruthy();
  expect((await snapshot(baz)).rendezvous[0]?.liveAudioDisabled).toBe(true);

  await ana.locator('.next-card').click();
  await expect(ana.locator('#rv-detail-audio-off')).toHaveText(
    'Live audio off for this rendezvous.',
  );
  await ana.locator('#rv-detail-close').click();
  await baz.locator('.next-card').click();
  await expect(baz.locator('#rv-detail-audio-off')).toBeVisible();
  await baz.locator('#rv-detail-close').click();

  await ana.clock.install();
  await baz.clock.install();
  await ana.clock.fastForward(2 * 60 * 60_000);
  await baz.clock.fastForward(2 * 60 * 60_000);

  await expect(ana.locator('#live-dialog')).toHaveAttribute('open', '');
  await expect(baz.locator('#live-dialog')).toHaveAttribute('open', '');
  await expect(ana.locator('#live-audio-disabled')).toHaveText(
    'Live audio is off for this rendezvous.',
  );
  await expect(baz.locator('#live-audio-disabled')).toBeVisible();
  await expect(ana.locator('#live-start-audio')).toBeHidden();
  await expect(baz.locator('#live-start-audio')).toBeHidden();

  const requestError = await ana.evaluate(async () => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => { rendezvous: Array<{ id: string }> };
        requestAudioMinute: (id: string) => Promise<void>;
      };
    };
    const id = app.clientInstance.getSnapshot().rendezvous[0]?.id;
    if (!id) return 'missing rendezvous';
    try {
      await app.clientInstance.requestAudioMinute(id);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'unknown error';
    }
  });
  expect(requestError).toContain('Live audio is off');

  await expect
    .poll(async () => (await snapshot(baz)).rendezvous.find((entry) => entry.id === appointmentId)?.status, {
      timeout: 30_000,
    })
    .toBe('delivered');
  await expect(baz.locator('.wall-photo')).toHaveCount(1);
  expect(errors).toEqual([]);

  await anaContext.close();
  await bazContext.close();
});
