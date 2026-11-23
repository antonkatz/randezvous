import { expect, test, type Page } from '@playwright/test';

async function setName(page: Page, name: string): Promise<void> {
  await page.locator('#code-name').fill(name);
  await page.locator('#code-name').blur();
}

async function createInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'add human' }).click();
  await page.waitForFunction(() => {
    const root = document.querySelector('rendezvous-app')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('#invite-link');
    return Boolean(input?.value.startsWith('http'));
  });
  const link = await page.locator('#invite-link').inputValue();
  await page.locator('#invite-close').click();
  return link;
}

test('mobile closes then desktop accepts', async ({ browser }) => {
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await mobileContext.newPage();
  const desktop = await desktopContext.newPage();

  await mobile.goto('/');
  await setName(mobile, 'Mobile');
  await desktop.goto('/');
  await setName(desktop, 'Desktop');

  const link = await createInvite(mobile);
  console.log('invite:', link);

  // Mobile disappears while the desktop accepts.
  await mobile.close();

  await desktop.goto(link);
  await expect(desktop.locator('#humans-list')).toContainText('Mobile');

  const mobile2 = await mobileContext.newPage();
  await mobile2.goto('/');
  await expect(mobile2.locator('#humans-list')).toContainText('Desktop', { timeout: 15_000 });

  await mobileContext.close();
  await desktopContext.close();
});

test('both online', async ({ browser }) => {
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await mobileContext.newPage();
  const desktop = await desktopContext.newPage();

  await mobile.goto('/');
  await setName(mobile, 'Mobile');
  await desktop.goto('/');
  await setName(desktop, 'Desktop');

  const link = await createInvite(mobile);
  await desktop.goto(link);
  await expect(desktop.locator('#humans-list')).toContainText('Mobile');
  await expect(mobile.locator('#humans-list')).toContainText('Desktop', { timeout: 15_000 });

  await mobileContext.close();
  await desktopContext.close();
});
