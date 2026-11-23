import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function setName(page: Page, name: string): Promise<void> {
  await page.locator('#code-name').fill(name);
  await page.locator('#code-name').blur();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector('randevouz-app') as unknown as {
      clientInstance: { getSnapshot: () => unknown };
    };
    return app.clientInstance.getSnapshot() as {
      humans: Array<{ id: string; name: string; online: boolean; verifiedAt: number | null }>;
      rendezvous: Array<{
        id: string;
        status: string;
        peerName: string;
        deliveredAt: number | null;
        photo: { size: number; type: string } | null;
      }>;
      signal: string;
      network: { remoteFamily: string; dualStack: boolean; warning: string | null } | null;
    };
  });
}

async function createInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'add human' }).click();
  await page.waitForFunction(() => {
    const root = document.querySelector('randevouz-app')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('#invite-link');
    return Boolean(input?.value.startsWith('http'));
  });
  const link = await page.locator('#invite-link').inputValue();
  await page.locator('#invite-close').click();
  return link;
}

async function linkPages(ana: Page, baz: Page): Promise<string> {
  await ana.goto('/');
  await setName(ana, 'Ana');
  await baz.goto('/');
  await setName(baz, 'Baz');
  await ana.waitForTimeout(250);
  const link = await createInvite(ana);
  await baz.goto(link);
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect(baz.locator('#humans-list')).toContainText('Ana');
  await expect(ana.locator('#humans-list')).toContainText('here now');
  await expect(baz.locator('#humans-list')).toContainText('here now');
  return link;
}

test('links two browsers, matches verification words, and hands off a photo only when both are present', async ({
  browser,
}) => {
  const anaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const bazContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const consoleErrors: string[] = [];
  ana.on('pageerror', (error) => consoleErrors.push(error.message));
  baz.on('pageerror', (error) => consoleErrors.push(error.message));

  await linkPages(ana, baz);

  await ana.locator('.human-chip').first().click();
  await expect(ana.locator('#verification-words li')).toHaveCount(8);
  const anaWords = await ana.locator('#verification-words').innerText();
  await baz.locator('.human-chip').first().click();
  await expect(baz.locator('#verification-words li')).toHaveCount(8);
  const bazWords = await baz.locator('#verification-words').innerText();
  expect(bazWords).toBe(anaWords);
  await ana.locator('#mark-verified').click();
  await baz.locator('#mark-verified').click();
  await expect(ana.locator('#human-dialog-badge')).toHaveText(/verified/iu);
  await expect(baz.locator('#human-dialog-badge')).toHaveText(/verified/iu);
  await ana.locator('#human-close').click();
  await baz.locator('#human-close').click();

  // Reloading loses the live connection but keeps the pinned relationship.
  await ana.reload();
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect.poll(async () => (await snapshot(ana)).humans[0]?.online).toBe(true);
  await ana.locator('.human-chip').first().click();
  await expect(ana.locator('#human-dialog-badge')).toHaveText(/verified/iu);
  await ana.locator('#human-close').click();

  const anaSnapshot = await snapshot(ana);
  const humanId = anaSnapshot.humans[0]?.id;
  expect(humanId).toBeTruthy();

  const scheduled = await ana.evaluate(
    async ({ humanId }) => {
      const app = document.querySelector('randevouz-app') as unknown as {
        clientInstance: {
          scheduleRendezvous: (input: {
            humanId: string;
            photo: File;
            fileName: string;
            scheduledFor: number;
          }) => Promise<{ id: string; photo: { size: number } | null }>;
        };
      };

      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 800;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No canvas');
      let seed = 123456789;
      const image = context.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < image.data.length; index += 4) {
        seed = (1103515245 * seed + 12345) >>> 0;
        image.data[index] = seed & 255;
        image.data[index + 1] = (seed >>> 8) & 255;
        image.data[index + 2] = (seed >>> 16) & 255;
        image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('No blob'))), 'image/png');
      });
      const file = new File([blob], 'randevouz-e2e.png', { type: 'image/png' });
      const record = await app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo: file,
        fileName: file.name,
        scheduledFor: Date.now() + 5_000,
      });
      return { id: record.id, size: blob.size };
    },
    { humanId: humanId! },
  );
  expect(scheduled.size).toBeGreaterThan(100_000);

  // Before the meeting, both sides know it is scheduled but nothing crossed.
  await expect.poll(async () => (await snapshot(baz)).rendezvous[0]?.status).toBe('scheduled');
  expect((await snapshot(baz)).rendezvous[0]?.photo).toBeNull();

  await expect
    .poll(async () => (await snapshot(ana)).rendezvous[0]?.status, { timeout: 30_000 })
    .toBe('delivered');
  await expect
    .poll(async () => (await snapshot(baz)).rendezvous[0]?.status, { timeout: 30_000 })
    .toBe('delivered');
  const received = (await snapshot(baz)).rendezvous[0];
  expect(received?.photo?.size).toBe(scheduled.size);
  expect(received?.photo?.type).toBe('image/png');
  const diagnostics = await ana.evaluate(() => {
    const app = document.querySelector('randevouz-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          lastTransferDiagnostics: { selected: { localFamily: string; remoteFamily: string } | null } | null;
        };
      };
    };
    return app.clientInstance.getSnapshot().lastTransferDiagnostics;
  });
  expect(diagnostics).not.toBeNull();

  // The production build path through the server's static handler and diagnostics panel works.
  await ana.getByRole('button', { name: 'Open connection diagnostics' }).click();
  await expect(ana.locator('#diagnostics-panel')).toContainText(/this socket/iu);
  await expect(ana.locator('#diagnostics-panel')).toContainText('IPv4');
  await expect(ana.locator('#diagnostics-panel')).toContainText('single-stack');
  await expect(ana.locator('#diag-warning')).toBeVisible();

  await baz.locator('.wall-photo').first().click();
  await expect(baz.locator('.wall-photo')).toHaveCount(1);
  await expect(baz.locator('.wall-rank').first()).toHaveText('01');
  await expect(baz.locator('#photo-dialog')).toHaveAttribute('open', '');
  await expect(baz.locator('#photo-viewer-image')).toHaveAttribute('src', /^blob:/u);
  await baz.locator('#photo-viewer-close').click();

  // A second delivery re-ranks the wall: freshest is 01 and physically widest.
  const second = await ana.evaluate(
    async ({ humanId }) => {
      const app = document.querySelector('randevouz-app') as unknown as {
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
      const file = new File([bytes], 'second.png', { type: 'image/png' });
      return app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo: file,
        scheduledFor: Date.now() + 3_000,
      });
    },
    { humanId: humanId! },
  );
  await expect
    .poll(
      async () =>
        (await snapshot(baz)).rendezvous.find((entry) => entry.id === second.id)?.status,
      { timeout: 30_000 },
    )
    .toBe('delivered');
  await expect(baz.locator('.wall-photo')).toHaveCount(2);
  await expect(baz.locator('.wall-rank')).toHaveText(['01', '02']);
  const widths = await baz.evaluate(() => {
    const root = document.querySelector('randevouz-app')?.shadowRoot;
    return [...(root?.querySelectorAll<HTMLElement>('.wall-photo') ?? [])].map(
      (element) => Number.parseFloat(element.style.width),
    );
  });
  expect(widths[0]).toBeGreaterThan(widths[1] ?? 0);

  const store = await readFile('.rendezvous-test/e2e-store.json', 'utf8');
  expect(store).not.toContain('data:image');
  expect(store).not.toContain('randevouz-e2e.png');
  expect(store.length).toBeLessThan(200_000);
  expect(consoleErrors).toEqual([]);

  await anaContext.close();
  await bazContext.close();
});

test('waits when the recipient is offline and completes when they return', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const bazContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ana = await anaContext.newPage();
  let baz = await bazContext.newPage();
  await linkPages(ana, baz);

  const humanId = (await snapshot(ana)).humans[0]?.id;
  expect(humanId).toBeTruthy();
  const record = await ana.evaluate(
    async ({ humanId }) => {
      const app = document.querySelector('randevouz-app') as unknown as {
        clientInstance: {
          scheduleRendezvous: (input: {
            humanId: string;
            photo: File;
            scheduledFor: number;
          }) => Promise<{ id: string; scheduledFor: number }>;
        };
      };
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      const file = new File([bytes], 'waiting.png', { type: 'image/png' });
      return app.clientInstance.scheduleRendezvous({
        humanId: humanId!,
        photo: file,
        scheduledFor: Date.now() + 4_000,
      });
    },
    { humanId: humanId! },
  );

  await baz.close();
  await expect.poll(async () => (await snapshot(ana)).humans[0]?.online).toBe(false);
  await ana.waitForTimeout(5_000);
  await expect
    .poll(async () => (await snapshot(ana)).rendezvous.find((entry) => entry.id === record.id)?.status)
    .toBe('waiting');
  expect((await snapshot(ana)).rendezvous.find((entry) => entry.id === record.id)?.deliveredAt).toBeNull();

  baz = await bazContext.newPage();
  await baz.goto('/');
  await expect(baz.locator('#humans-list')).toContainText('Ana');
  await expect
    .poll(async () => (await snapshot(ana)).rendezvous.find((entry) => entry.id === record.id)?.status, {
      timeout: 30_000,
    })
    .toBe('delivered');
  await expect
    .poll(
      async () =>
        (await snapshot(baz)).rendezvous.find((entry) => entry.id === record.id)?.status,
      { timeout: 30_000 },
    )
    .toBe('delivered');

  await anaContext.close();
  await bazContext.close();
});

test('removing a human revokes the old invite so it cannot reconnect', async ({ browser }) => {
  const anaContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const bazContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ana = await anaContext.newPage();
  const baz = await bazContext.newPage();
  const link = await linkPages(ana, baz);

  await ana.locator('.human-chip').first().click();
  await ana.locator('#remove-human').click();
  await ana.locator('#confirm-remove').click();
  await expect(ana.locator('#humans-list')).toContainText('No humans yet');
  await expect(baz.locator('#humans-list')).toContainText('No humans yet');

  await baz.evaluate((oldLink) => {
    window.location.hash = new URL(oldLink).hash;
  }, link);
  await expect(baz.locator('#humans-list')).toContainText('No humans yet');
  await expect(baz.locator('#toast-region')).toContainText(/revoked/iu);
  await expect(ana.locator('#humans-list')).toContainText('No humans yet');

  // A browser with no local revocation memory must also be turned away by the bootstrap server.
  const cyContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const cy = await cyContext.newPage();
  await cy.goto('/');
  await setName(cy, 'Cy');
  await cy.goto(link);
  await expect(cy.locator('#humans-list')).toContainText('No humans yet');
  await expect(cy.locator('#toast-region')).toContainText(/revoked/iu);
  await expect(ana.locator('#humans-list')).toContainText('No humans yet');

  // A fresh invitation is a new capability and works.
  const freshLink = await createInvite(ana);
  await cy.goto(freshLink);
  await expect(ana.locator('#humans-list')).toContainText('Cy');
  await expect(cy.locator('#humans-list')).toContainText('Ana');

  await anaContext.close();
  await bazContext.close();
  await cyContext.close();
});
