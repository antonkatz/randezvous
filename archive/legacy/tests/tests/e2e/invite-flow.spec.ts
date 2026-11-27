import { expect, test, type Page } from '@playwright/test';
import { createRendezvousLink, setName } from './helpers';

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          identity: { id: string };
          humans: Array<{ id: string; name: string }>;
          rendezvous: Array<{
            id: string;
            direction: string;
            peerId: string;
            peerName: string;
            status: string;
            inviteToken: string | null;
            scheduledFor: number;
          }>;
        };
      };
    };
    return app.clientInstance.getSnapshot();
  });
}

test('a rendezvous for someone new is already waiting when they join', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  const bazContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const cyContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const cy = await cyContext.newPage();
  const errors: string[] = [];
  ana.on('pageerror', (error) => errors.push(`Ana: ${error.message}`));
  baz.on('pageerror', (error) => errors.push(`Baz: ${error.message}`));
  cy.on('pageerror', (error) => errors.push(`Cy: ${error.message}`));

  await ana.goto('/');
  await setName(ana, 'Ana');
  await expect(ana.locator('#add-human')).toHaveCount(0);
  await expect(ana.locator('#humans-list')).toContainText('Set a rendezvous for someone new');

  const created = await createRendezvousLink(ana);
  expect(created.appointmentId).toBeTruthy();
  const before = await snapshot(ana);
  expect(before.humans).toHaveLength(0);
  const pending = before.rendezvous.find((entry) => entry.id === created.appointmentId);
  expect(pending?.status).toBe('awaiting-join');
  expect(pending?.inviteToken).toBeTruthy();
  await expect(ana.locator('#upcoming-list')).toContainText('for someone new');
  await expect(ana.locator('#upcoming-list')).toContainText('waiting for them to join');
  await expect(ana.locator('#upcoming-wrap')).toBeVisible();
  await expect(ana.locator('#wall-wrap')).toBeHidden();

  await baz.goto('/');
  await setName(baz, 'Baz');
  await baz.goto(created.link);

  // The recipient has the human and the already-set rendezvous immediately.
  await expect(baz.locator('#humans-list')).toContainText('Ana');
  const received = (await snapshot(baz)).rendezvous.find(
    (entry) => entry.id === created.appointmentId,
  );
  expect(received?.direction).toBe('incoming');
  expect(received?.scheduledFor).toBe(pending?.scheduledFor);

  // The creator attaches the same appointment to the joining human.
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect
    .poll(async () => {
      const record = (await snapshot(ana)).rendezvous.find(
        (entry) => entry.id === created.appointmentId,
      );
      return record ? `${record.status}:${record.peerName}:${record.inviteToken}` : 'missing';
    })
    .toMatch(/^(scheduled|waiting):Baz:null$/u);
  expect(
    (await snapshot(ana)).rendezvous.filter((entry) => entry.id === created.appointmentId),
  ).toHaveLength(1);

  // The first browser bound the link; another browser is refused.
  await cy.goto('/');
  await setName(cy, 'Cy');
  await cy.goto(created.link);
  await expect(cy.locator('#toast-region')).toContainText(/already been claimed|revoked/iu);
  await expect(cy.locator('#humans-list')).toContainText('No humans yet');
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect(ana.locator('#humans-list')).not.toContainText('Cy');

  // The rendezvous itself completes normally from the pre-join appointment.
  await ana.clock.install();
  await baz.clock.install();
  await ana.clock.fastForward(61 * 60_000);
  await baz.clock.fastForward(61 * 60_000);
  await expect
    .poll(async () => {
      const record = (await snapshot(baz)).rendezvous.find(
        (entry) => entry.id === created.appointmentId,
      );
      return record?.status;
    }, { timeout: 30_000 })
    .toBe('delivered');

  expect(errors).toEqual([]);
  await anaContext.close();
  await bazContext.close();
  await cyContext.close();
});
