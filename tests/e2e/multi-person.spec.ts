import { expect, test } from '@playwright/test';
import { createRendezvousLink, linkPages, setName, TINY_PNG } from './helpers';

test('one direct rendezvous can invite several people at once', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const cidContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const cid = await cidContext.newPage();
  const errors: string[] = [];
  for (const [label, page] of [
    ['Ana', ana],
    ['Baz', baz],
    ['Cid', cid],
  ] as const) {
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  }

  await linkPages(ana, baz);
  const cidLink = await createRendezvousLink(ana, 'cid-link.png');
  await cid.goto('/');
  await setName(cid, 'Cid');
  await cid.goto(cidLink.link);
  await expect(ana.locator('#humans-list')).toContainText('Cid', { timeout: 20_000 });
  await expect(cid.locator('#humans-list')).toContainText('Ana');
  await ana.evaluate(async (id) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { deleteRendezvous: (value: string) => Promise<void> };
    };
    await app.clientInstance.deleteRendezvous(id);
  }, cidLink.appointmentId);
  await cid.evaluate(async (id) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { deleteRendezvous: (value: string) => Promise<void> };
    };
    await app.clientInstance.deleteRendezvous(id);
  }, cidLink.appointmentId);

  const summary = await ana.evaluate(async () => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          humans: Array<{ id: string; name: string }>;
        };
        scheduleRendezvous: (input: {
          humanIds: string[];
          photo: File;
          fileName: string;
          scheduledFor: number;
        }) => Promise<{
          id: string;
          participants: Array<{ id: string }>;
          deliveredTo: string[];
          status: string;
        }>;
      };
    };
    const humans = app.clientInstance.getSnapshot().humans;
    const file = new File([Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII='),
      (character) => character.charCodeAt(0),
    )], 'group.png', { type: 'image/png' });
    const record = await app.clientInstance.scheduleRendezvous({
      humanIds: humans.map((human) => human.id),
      photo: file,
      fileName: file.name,
      scheduledFor: Date.now() + 60 * 60_000,
    });
    return {
      id: record.id,
      participants: record.participants.length,
    };
  });
  expect(summary.participants).toBe(3);

  for (const page of [ana, baz, cid]) await page.clock.install();
  for (const page of [ana, baz, cid]) await page.clock.fastForward(2 * 60 * 60_000);

  await expect
    .poll(
      async () =>
        ana.evaluate((id) => {
          const app = document.querySelector('rendezvous-app') as unknown as {
            clientInstance: {
              getSnapshot: () => {
                rendezvous: Array<{ id: string; deliveredTo: string[]; status: string }>;
              };
            };
          };
          const record = app.clientInstance
            .getSnapshot()
            .rendezvous.find((entry) => entry.id === id);
          return record?.deliveredTo.length ?? 0;
        }, summary.id),
      { timeout: 30_000 },
    )
    .toBe(2);
  await expect(baz.locator('.wall-photo')).toHaveCount(1, { timeout: 30_000 });
  await expect(cid.locator('.wall-photo')).toHaveCount(1, { timeout: 30_000 });
  expect(errors).toEqual([]);

  await anaContext.close();
  await bazContext.close();
  await cidContext.close();
});
