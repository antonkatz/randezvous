import { expect, test } from '@playwright/test';
import { createRendezvousLink, setName } from './helpers';

test('a named circle participant who links later receives the existing rendezvous', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const cidContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const cid = await cidContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  cid.on('pageerror', (error) => errors.push(`Cid: ${error.message}`));

  await ana.goto('/');
  await setName(ana, 'Ana');
  await ana.locator('circle-bar').getByRole('button', { name: 'Create a circle' }).click();
  const form = ana.locator('circle-create-form');
  await form.locator('input[name="name"]').fill('Distant Garden');
  await form.locator('input[name="timezone"]').fill('Europe/Berlin');
  await form.getByRole('button', { name: 'create circle' }).click();
  await expect(ana.locator('circle-stats-page')).toContainText('Distant Garden');
  await ana.locator('#circle-close').click();

  await cid.goto('/');
  await setName(cid, 'Cid');
  const cidId = await cid.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { getSnapshot: () => { identity: { id: string } } };
    };
    return app.clientInstance.getSnapshot().identity.id;
  });

  const circleId = await ana.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      circleEntries: Array<{ circleId: string }>;
    };
    return app.circleEntries[0]?.circleId ?? '';
  });
  expect(circleId).toBeTruthy();

  const cidLink = await createRendezvousLink(ana, 'cid-ana.png');

  const rendezvousId = await ana.evaluate(async ({ circleId: id, cidId: participant }) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        scheduleRendezvous: (input: {
          recipients: Array<{ id: string; name: string }>;
          circleId: string;
          photo: File;
          fileName: string;
          scheduledFor: number;
        }) => Promise<{ id: string }>;
      };
    };
    const file = new File([Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII='),
      (character) => character.charCodeAt(0),
    )], 'distant-garden.png', { type: 'image/png' });
    const record = await app.clientInstance.scheduleRendezvous({
      recipients: [{ id: participant, name: 'Cid' }],
      circleId: id,
      photo: file,
      fileName: file.name,
      scheduledFor: Date.now() + 60 * 60_000,
    });
    return record.id;
  }, { circleId, cidId });

  const before = await cid.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          rendezvous: Array<{ circleId: string | null }>;
        };
      };
    };
    return app.clientInstance
      .getSnapshot()
      .rendezvous.some((entry) => entry.circleId);
  });
  expect(before).toBe(false);

  await cid.goto(cidLink.link);
  await expect(cid.locator('#humans-list')).toContainText('Ana', { timeout: 25_000 });
  await expect
    .poll(
      async () =>
        cid.evaluate((id) => {
          const app = document.querySelector('rendezvous-app') as unknown as {
            clientInstance: {
              getSnapshot: () => {
                rendezvous: Array<{
                  id: string;
                  circleId: string | null;
                  participants: Array<{ id: string }>;
                }>;
              };
            };
          };
          const record = app.clientInstance
            .getSnapshot()
            .rendezvous.find((entry) => entry.id === id);
          return record?.participants.length ?? 0;
        }, rendezvousId),
      { timeout: 30_000 },
    )
    .toBe(2);

  expect(errors).toEqual([]);
  await anaContext.close();
  await cidContext.close();
});
