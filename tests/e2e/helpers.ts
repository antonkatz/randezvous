import { expect, type Page } from '@playwright/test';

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlB8AAAAASUVORK5CYII=',
  'base64',
);

export async function setName(page: Page, name: string): Promise<void> {
  await page.locator('#code-name').fill(name);
  await page.locator('#code-name').blur();
}

export interface RendezvousLink {
  link: string;
  appointmentId: string;
}

/** Create the first human relationship through a rendezvous for someone new. */
export async function createRendezvousLink(
  page: Page,
  fileName = 'first-meeting.png',
): Promise<RendezvousLink> {
  await page.locator('#set-rendezvous').click();
  await page.locator('#photo-input').setInputFiles({
    name: fileName,
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  const newPerson = page.locator('.human-option.is-new');
  if (await newPerson.count()) await newPerson.click();
  await expect(page.locator('#rv-next')).toBeEnabled();
  await page.locator('#rv-next').click();
  await expect(page.locator('#rv-schedule')).toBeEnabled();
  await page.locator('#rv-schedule').click();
  await expect(page.locator('#rv-step-3')).toBeVisible();
  await expect(page.locator('#done-link')).toHaveValue(/^http/u);

  const link = await page.locator('#done-link').inputValue();
  const appointmentId = await page.evaluate(() => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: {
        getSnapshot: () => {
          rendezvous: Array<{ id: string; status: string }>;
        };
      };
    };
    return (
      app.clientInstance
        .getSnapshot()
        .rendezvous.find((record) => record.status === 'awaiting-join')?.id ?? ''
    );
  });
  await page.locator('#rv-finish').click();
  return { link, appointmentId };
}

async function deleteRendezvous(page: Page, id: string): Promise<void> {
  if (!id) return;
  await page.evaluate(async ({ appointmentId }) => {
    const app = document.querySelector('rendezvous-app') as unknown as {
      clientInstance: { deleteRendezvous: (value: string) => Promise<void> };
    };
    await app.clientInstance.deleteRendezvous(appointmentId);
  }, { appointmentId: id });
}

/** Link two fresh pages through the rendezvous they set for someone new. */
export async function linkPages(
  ana: Page,
  baz: Page,
): Promise<RendezvousLink> {
  await ana.goto('/');
  await setName(ana, 'Ana');
  await baz.goto('/');
  await setName(baz, 'Baz');
  await ana.waitForTimeout(250);
  const created = await createRendezvousLink(ana);
  await baz.goto(created.link);
  await expect(ana.locator('#humans-list')).toContainText('Baz');
  await expect(baz.locator('#humans-list')).toContainText('Ana');
  await expect(ana.locator('#humans-list')).toContainText('here now');
  await expect(baz.locator('#humans-list')).toContainText('here now');
  await deleteRendezvous(ana, created.appointmentId);
  await deleteRendezvous(baz, created.appointmentId);
  return created;
}

export async function createFreshLink(page: Page): Promise<string> {
  const created = await createRendezvousLink(page, 'fresh-link.png');
  return created.link;
}
