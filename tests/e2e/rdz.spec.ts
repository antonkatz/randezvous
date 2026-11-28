import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

const LANDSCAPE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAEACAIAAABK8lkwAAADn0lEQVR4nO3VQQEAEADAQCQURxxRxfDYXYL9Ns++A4Ce9TsAgD8MACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiDAAgygAAogwAIMoAAKIMACDKAACiHj8fA2hw3SSwAAAAAElFTkSuQmCC',
  'base64',
);

function futureTime(): string {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function openPage(
  browser: Browser,
  query = '',
  viewport?: { width: number; height: number },
): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page; errors: string[] }> {
  const context = await browser.newContext(viewport ? { viewport, hasTouch: true } : {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.live')).toHaveText(/live|off/);
  return { context, page, errors };
}

async function expectLive(page: Page): Promise<void> {
  await expect(page.locator('.live')).toHaveText('live');
}

async function identityWords(page: Page): Promise<string> {
  return (await page.locator('.topbar .identity-words').innerText()).trim();
}

async function createChannel(page: Page, time: string): Promise<string> {
  await page.getByRole('button', { name: 'Set a rendezvous' }).click();
  await page.locator('input[name=time]').fill(time);
  await page.getByRole('button', { name: 'create & go' }).click();
  await expect(page.locator('.channel-title')).toBeVisible();
  return (await page.locator('.channel-title .mono').innerText()).trim();
}

async function openChannel(page: Page, fullWords: string): Promise<void> {
  const short = fullWords.split(' ').slice(0, 4).join(' ');
  const card = page.locator('.channel-card').filter({ hasText: short }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('.channel-title')).toBeVisible();
}

async function announce(page: Page, time: string): Promise<void> {
  await page.getByRole('button', { name: /(set|add) a time/ }).click();
  await page.locator('input[name=time]').fill(time);
  await page.getByRole('button', { name: 'announce time' }).click();
  await expect(page.locator('.time-group').first()).toBeVisible();
}

function beingRow(page: Page, shortWords: string) {
  return page.locator('.being-row').filter({ hasText: shortWords }).first();
}

async function orbitProgress(page: Page): Promise<number> {
  return page.locator('.hero .orbit').evaluate((orbit) => {
    const distance = getComputedStyle(orbit, '::after').offsetDistance;
    return Number.parseFloat(distance);
  });
}

async function verify(page: Page, shortWords: string): Promise<void> {
  const row = beingRow(page, shortWords);
  await row.locator('.being-main').click();
  await page.getByRole('button', { name: 'mark as verified' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

async function setupPair(browser: Browser, phoneFirst = false): Promise<{
  a: Awaited<ReturnType<typeof openPage>>;
  b: Awaited<ReturnType<typeof openPage>>;
  aWords: string;
  bWords: string;
  channel: string;
}> {
  const time = futureTime();
  const a = await openPage(browser, '', phoneFirst ? { width: 390, height: 844 } : undefined);
  const b = await openPage(browser);
  await expectLive(a.page);
  await expectLive(b.page);
  const aWords = await identityWords(a.page);
  const bWords = await identityWords(b.page);
  const channel = await createChannel(a.page, time);
  await openChannel(b.page, channel);
  await announce(b.page, time);
  await expect(beingRow(a.page, bWords)).toBeVisible();
  await verify(a.page, bWords);
  await verify(b.page, aWords);
  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toBeVisible();
  return { a, b, aWords, bWords, channel };
}

test('the landing traffic stream opens the full network page', async ({ browser }) => {
  const a = await openPage(browser);

  const stream = a.page.locator('.traffic-stream');
  await expect(stream).toBeVisible();
  await expect(stream).toContainText('network traffic');
  await stream.click();

  await expect(a.page.locator('.traffic-page h1')).toHaveText('Network traffic');
  await expect(a.page.locator('.traffic-stat.is-coming')).toContainText('inbound');
  await expect(a.page.locator('.traffic-stat.is-going')).toContainText('outbound');
  const first = a.page.locator('.traffic-entry').first();
  await expect(first).toBeVisible();
  const firstId = await first.getAttribute('data-id');
  const entry = a.page.locator(`.traffic-entry[data-id="${firstId}"]`);
  await entry.click();
  await expect(entry).toHaveAttribute('aria-expanded', 'true');
  await expect(entry.locator('.traffic-detail')).toContainText('author');
  await expect(entry.locator('.traffic-detail')).toContainText('created');

  await a.page.getByRole('button', { name: /back/i }).click();
  await expect(stream).toBeVisible();

  await a.context.close();
});

test('the empty rendezvous panel offers a set-one button', async ({ browser }) => {
  const a = await openPage(browser, '?seed=off');
  const action = a.page.locator('[data-region="channels-panel"] [data-action="new-rendezvous"]');

  await expect(action).toBeVisible();
  await expect(action).toHaveRole('button');
  await expect(action).toContainText('No live rendezvous. Set one.');
  await expect(action.locator('.empty-link')).toHaveCSS('text-decoration-line', 'underline');

  await action.click();
  await expect(a.page.getByRole('heading', { name: 'Set a rendezvous' })).toBeVisible();
  await expect(a.page.locator('input[name=time]')).toBeVisible();

  await a.context.close();
});

test('the version stamp is faded in the top right corner', async ({ browser }) => {
  const a = await openPage(browser);
  const stamp = a.page.locator('.version-stamp');

  await expect(stamp).toBeVisible();
  await expect(stamp).toHaveText(`v${VERSION}`);
  await expect(stamp).toHaveCSS('position', 'fixed');
  await expect(stamp).toHaveCSS('pointer-events', 'none');

  const box = await stamp.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top,
      right: window.innerWidth - rect.right,
      opacity: Number(getComputedStyle(node).opacity),
    };
  });

  expect(box.top).toBeLessThan(24);
  expect(box.right).toBeLessThan(24);
  // Faded, but still legible.
  expect(box.opacity).toBeGreaterThan(0.2);
  expect(box.opacity).toBeLessThan(1);

  // The stamp lives in the shell, so it survives moving to another view.
  await a.page.locator('.traffic-stream').click();
  await expect(a.page.locator('.traffic-page h1')).toHaveText('Network traffic');
  await expect(stamp).toHaveText(`v${VERSION}`);

  expect(a.errors).toEqual([]);
  await a.context.close();
});

test('verified-only signalling is styled, keyboard accessible, persistent, and mask-local', async ({ browser }) => {
  const a = await openPage(browser, '?seed=off');
  const first = await identityWords(a.page);
  const toggle = a.page.locator('.traffic-signalling .signal-toggle');
  const track = toggle.locator('.switch-track');
  const thumb = toggle.locator('.switch-thumb');

  await expect(toggle).toHaveAttribute('role', 'switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Rely only on verified beings for signalling');
  await expect(track).toHaveCSS('border-radius', '999px');
  await expect(toggle).toHaveCSS('min-height', '36px');
  await expect(toggle).toHaveCSS('border-top-width', '0px');
  await expect(toggle).toHaveCSS('box-shadow', 'none');
  await expect(a.page.locator('.topbar .signal-toggle')).toHaveCount(0);
  await expect(a.page.locator('.signal-policy-note')).toContainText(
    'We encourage you to keep this on to help the network stay connected and strong',
  );
  await expect(a.page.locator('.signal-policy-note')).toContainText(
    'but we understand if you turn it off.',
  );
  const why = a.page.getByRole('button', { name: 'read why?' });
  await expect(why).toHaveAttribute('aria-expanded', 'false');
  await why.click();
  await expect(why).toHaveAttribute('aria-expanded', 'true');
  await expect(a.page.locator('.signal-explainer')).toBeVisible();
  await expect(a.page.locator('.signal-explainer')).toContainText(
    'Every peer you connect with helps other beings find a route to one another',
  );
  await expect(a.page.locator('.signal-explainer')).toContainText(
    'No personal data passes through your browser',
  );
  await expect(a.page.locator('.signal-explainer')).toContainText(
    'photographs and voice travel only between the beings sending and receiving them',
  );
  await expect(a.page.locator('.signal-explainer')).toContainText('broader reachability');
  await why.click();
  await expect(why).toHaveAttribute('aria-expanded', 'false');
  await expect(a.page.locator('.signal-explainer')).toBeHidden();
  const offTransform = await thumb.evaluate((node) => getComputedStyle(node).transform);

  await toggle.focus();
  await a.page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveClass(/is-on/);
  await expect(track).toHaveCSS('background-color', 'rgb(111, 104, 92)');
  await expect(a.page.getByRole('status')).toContainText('Verified-only signalling on.');
  const onTransform = await thumb.evaluate((node) => getComputedStyle(node).transform);
  expect(onTransform).not.toBe(offTransform);

  await a.page.locator('.identity-chip').click();
  const modalToggle = a.page.locator('.modal .signal-toggle');
  await expect(modalToggle).toHaveAttribute('aria-checked', 'true');
  await expect(a.page.locator('.signal-policy')).toContainText('Public presence and rendezvous discovery stay open.');
  await modalToggle.click();
  await expect(modalToggle).toHaveAttribute('aria-checked', 'false');
  await a.page.locator('.modal-actions [data-action="close-modal"]').click();

  await a.page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await a.page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await a.page.locator('.identity-chip').click();
  await a.page.getByRole('button', { name: 'new mask' }).click();
  await expect.poll(async () => identityWords(a.page)).not.toBe(first);
  await expect(a.page.locator('.traffic-signalling .signal-toggle')).toHaveAttribute('aria-checked', 'false');

  const firstRow = a.page
    .locator('.mask-row')
    .filter({ hasText: first.split(' ').slice(0, 4).join(' ') });
  await firstRow.getByRole('button', { name: 'switch' }).click();
  await expect.poll(async () => identityWords(a.page)).toBe(first);
  await expect(a.page.locator('.traffic-signalling .signal-toggle')).toHaveAttribute('aria-checked', 'true');

  expect(a.errors).toEqual([]);
  await a.context.close();
});

test('presence, channel, verification, and the unverified gate', async ({ browser }) => {
  const time = futureTime();
  const a = await openPage(browser);
  const b = await openPage(browser);
  await expectLive(a.page);
  await expectLive(b.page);
  const aWords = await identityWords(a.page);
  const bWords = await identityWords(b.page);

  await expect(beingRow(a.page, bWords)).toBeVisible();
  await expect(beingRow(b.page, aWords)).toBeVisible();

  const channel = await createChannel(a.page, time);
  await openChannel(b.page, channel);
  await announce(b.page, time);

  await expect(beingRow(a.page, bWords)).toBeVisible();
  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toHaveCount(0);
  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'verify' })).toBeVisible();

  await verify(a.page, bWords);
  await verify(b.page, aWords);

  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toBeVisible();
  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'open voice' })).toBeVisible();
  await expect(beingRow(a.page, bWords)).toContainText('✓ verified');

  await a.context.close();
  await b.context.close();
});

test('image consent, direct transfer, save, dismiss, reuse, and decline', async ({ browser }, testInfo) => {
  const { a, b, aWords, bWords } = await setupPair(browser);
  const file = testInfo.outputPath('one.png');
  writeFileSync(file, PNG);
  const senderEmoji = (await beingRow(b.page, aWords).locator('.being-emoji').innerText()).trim();

  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);

  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await expect(b.page.locator('.offer')).toContainText(/\d+(\.\d+)? (B|KB|MB)/);
  await expect(b.page.locator('.offer .offer-emoji')).toContainText(senderEmoji);
  await expect(b.page.locator('.offer .verified-check')).toHaveText('✓');
  await expect(b.page.locator('.offer img')).toHaveCount(0);
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('img.received-image')).toBeVisible();
  await expect(b.page.locator('a[download]')).toBeVisible();
  await b.page.getByRole('button', { name: 'dismiss' }).click();
  await expect(b.page.locator('img.received-image')).toHaveCount(0);

  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await expect(a.page.getByRole('button', { name: /reuse last image/ })).toBeVisible();
  await a.page.getByRole('button', { name: /reuse last image/ }).click();
  await expect(b.page.getByRole('button', { name: 'decline', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'decline', exact: true }).click();
  await expect(a.page.getByText('The image was declined.')).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('a photo transfer can be cancelled by either side', async ({ browser }, testInfo) => {
  const { a, b, bWords } = await setupPair(browser);
  const file = testInfo.outputPath('cancel.png');
  const body = Buffer.alloc(4 * 1024 * 1024);
  PNG.copy(body);
  writeFileSync(file, body);

  // Sender cancels while the offer is waiting.
  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await expect(a.page.locator('.progress-panel').getByRole('button', { name: 'cancel' })).toBeVisible();
  await a.page.locator('.progress-panel').getByRole('button', { name: 'cancel' }).click();
  await expect(a.page.getByRole('status')).toContainText('Image transfer cancelled.');
  await expect(b.page.getByRole('status')).toContainText('The sender cancelled the transfer.');
  await expect(b.page.locator('.offer')).toHaveCount(0);

  // Recipient cancels after accepting, while the direct connection is starting.
  // Hold binary chunks in the sender so the progress row stays active long
  // enough to exercise the recipient's cancel control deterministically.
  await a.page.evaluate(() => {
    const originalSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data: string | ArrayBuffer | ArrayBufferView) {
      if (typeof data !== 'string') return;
      originalSend.call(this, data);
    };
  });
  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: /reuse last image/ }).click();
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('.progress-panel').getByRole('button', { name: 'cancel' })).toBeVisible();
  await b.page.locator('.progress-panel').getByRole('button', { name: 'cancel' }).click();
  await expect(b.page.getByRole('status')).toContainText('Image transfer cancelled.');
  await expect(a.page.getByRole('status')).toContainText('The recipient cancelled the transfer.');
  await expect(a.page.locator('.progress-panel')).toHaveCount(0);
  await expect(b.page.locator('.progress-panel')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});

test('a wide coarse-pointer screen keeps the scrollable received-photo dialog', async ({ browser }, testInfo) => {
  const a = await openPage(browser);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
    isMobile: true,
  });
  const b = { context, page: await context.newPage(), errors: [] as string[] };
  b.page.on('pageerror', (error) => b.errors.push(error.message));
  await b.page.goto('/');
  await expectLive(a.page);
  await expectLive(b.page);
  expect(await b.page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(false);
  const aWords = await identityWords(a.page);
  const bWords = await identityWords(b.page);
  const time = futureTime();
  const channel = await createChannel(a.page, time);
  await openChannel(b.page, channel);
  await announce(b.page, time);
  await expect(beingRow(a.page, bWords)).toBeVisible();
  await verify(a.page, bWords);
  await verify(b.page, aWords);

  const file = testInfo.outputPath('wide-touch.png');
  writeFileSync(file, PNG);
  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('img.received-image')).toBeVisible();
  await expect(b.page.locator('.image-viewer-backdrop.desktop')).toHaveCount(0);
  await expect(b.page.locator('.image-viewer .modal-actions')).toBeInViewport();
  expect(
    await b.page.evaluate(() => getComputedStyle(document.documentElement).overflow),
  ).toBe('visible');
  expect(b.errors).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('a received landscape photo fits every desktop viewport with its actions visible', async ({ browser }, testInfo) => {
  const { a, b, aWords, bWords } = await setupPair(browser);
  expect(await b.page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
  const file = testInfo.outputPath('desktop-landscape.png');
  writeFileSync(file, LANDSCAPE_PNG);

  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('img.received-image')).toBeVisible();
  await expect(b.page.locator('.image-viewer-backdrop.desktop')).toBeVisible();
  await expect
    .poll(() =>
      b.page.locator('.received-image').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);

  await b.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrollPosition = await b.page.evaluate(() => window.scrollY);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 600 },
    { width: 821, height: 500 },
    { width: 821, height: 320 },
  ]) {
    await b.page.setViewportSize(viewport);
    await expect
      .poll(() =>
        b.page.locator('.received-image').evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);

    const layout = await b.page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>('.received-image')!;
      const viewport = document.querySelector<HTMLElement>('.received-image-viewport')!;
      const dialog = document.querySelector<HTMLElement>('.image-viewer')!;
      const masthead = document.querySelector<HTMLElement>('.masthead')!;
      const imageBox = image.getBoundingClientRect();
      const viewportBox = viewport.getBoundingClientRect();
      const actions = [...dialog.querySelectorAll<HTMLElement>('.modal-actions a, .modal-actions button')].map(
        (element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          };
        },
      );
      return {
        rootOverflow: getComputedStyle(document.documentElement).overflow,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        verticalOverflow: document.documentElement.scrollHeight > window.innerHeight + 1,
        dialogOverflow: getComputedStyle(dialog).overflow,
        dialogScroll: dialog.scrollHeight > dialog.clientHeight + 1,
        viewportScroll: viewport.scrollHeight > viewport.clientHeight + 1,
        mastheadBottom: masthead.getBoundingClientRect().bottom,
        dialogTop: dialog.getBoundingClientRect().top,
        dialogBottom: dialog.getBoundingClientRect().bottom,
        image: {
          width: imageBox.width,
          height: imageBox.height,
          left: imageBox.left,
          right: imageBox.right,
          top: imageBox.top,
          bottom: imageBox.bottom,
        },
        viewport: {
          width: viewportBox.width,
          height: viewportBox.height,
        },
        actions,
      };
    });

    expect(layout.verticalOverflow).toBe(false);
    expect(layout.rootOverflow).toBe('hidden');
    expect(layout.horizontalOverflow).toBe(false);
    expect(layout.dialogOverflow).toBe('hidden');
    expect(layout.dialogScroll).toBe(false);
    expect(layout.viewportScroll).toBe(false);
    expect(
      await b.page.locator('.received-image').evaluate((image: HTMLImageElement) => getComputedStyle(image).objectFit),
    ).toBe('contain');
    expect(layout.dialogTop).toBeGreaterThanOrEqual(layout.mastheadBottom);
    expect(layout.dialogBottom).toBeLessThanOrEqual(viewport.height);
    expect(layout.image.width).toBeGreaterThan(0);
    expect(layout.image.height).toBeGreaterThan(0);
    expect(layout.image.width).toBeLessThanOrEqual(layout.viewport.width + 1);
    expect(layout.image.height).toBeLessThanOrEqual(layout.viewport.height + 1);
    expect(layout.image.left).toBeGreaterThanOrEqual(0);
    expect(layout.image.right).toBeLessThanOrEqual(viewport.width);
    expect(layout.image.top).toBeGreaterThanOrEqual(0);
    expect(layout.image.bottom).toBeLessThanOrEqual(viewport.height);
    for (const action of layout.actions) {
      expect(action.left).toBeGreaterThanOrEqual(0);
      expect(action.right).toBeLessThanOrEqual(viewport.width);
      expect(action.top).toBeGreaterThanOrEqual(0);
      expect(action.bottom).toBeLessThanOrEqual(viewport.height);
    }
    expect(await b.page.evaluate(() => window.scrollY)).toBe(scrollPosition);
  }

  await b.page.getByRole('button', { name: 'dismiss' }).click();
  await expect(b.page.locator('img.received-image')).toHaveCount(0);
  await expect.poll(() => b.page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('visible');
  expect(await b.page.evaluate(() => window.scrollY)).toBe(scrollPosition);

  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: /reuse last image/ }).click();
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('img.received-image')).toBeVisible();
  await b.page.locator('[data-action="back"]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(b.page.locator('img.received-image')).toHaveCount(0);
  await expect.poll(() => b.page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('visible');
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('a photo travels from a phone-sized sender to a desktop', async ({ browser }, testInfo) => {
  const { a, b, bWords } = await setupPair(browser, true);
  const file = testInfo.outputPath('phone.png');
  const body = Buffer.alloc(2 * 1024 * 1024);
  PNG.copy(body);
  writeFileSync(file, body);

  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);

  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('img.received-image')).toBeVisible({ timeout: 30_000 });
  await expect(a.page.locator('.transfer')).toHaveCount(0, { timeout: 15_000 });
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('one-minute audio request, consent, live panel, and end', async ({ browser }) => {
  const { a, b, aWords, bWords } = await setupPair(browser);
  const aEmoji = (await beingRow(b.page, aWords).locator('.being-emoji').innerText()).trim();
  const bEmoji = (await beingRow(a.page, bWords).locator('.being-emoji').innerText()).trim();

  await beingRow(a.page, bWords).getByRole('button', { name: 'open voice' }).click();
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await expect(b.page.locator('.offer .offer-emoji')).toContainText(aEmoji);
  await expect(b.page.locator('.offer')).toContainText('✓ verified');
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();

  await expect(a.page.locator('.audio-panel')).toBeVisible();
  await expect(b.page.locator('.audio-panel')).toBeVisible();
  await expect(a.page.locator('.audio-panel .being-emoji')).toHaveText(bEmoji);
  await expect(b.page.locator('.audio-panel .being-emoji')).toHaveText(aEmoji);
  await expect(a.page.locator('.audio-panel')).toContainText('live');
  await expect(a.page.locator('.pink-bar')).toBeVisible();
  await expect(a.page.locator('.pink-bar')).not.toContainText(/\d/);

  await a.page.getByRole('button', { name: 'end', exact: true }).click();
  await expect(a.page.locator('.audio-panel')).toHaveCount(0);
  await expect(b.page.locator('.audio-panel')).toHaveCount(0);
  await expect(b.page.getByRole('status')).toContainText(
    'The other person ended the voice conversation.',
  );

  await a.context.close();
  await b.context.close();
});

test('declining a voice request tells the requester', async ({ browser }) => {
  const { a, b, bWords } = await setupPair(browser);

  await beingRow(a.page, bWords).getByRole('button', { name: 'open voice' }).click();
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'decline', exact: true }).click();

  await expect(a.page.getByRole('status')).toContainText('The voice request was declined.');
  await expect(a.page.locator('.audio-panel')).toHaveCount(0);
  await expect(b.page.locator('.audio-panel')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});

test('a phone clock ahead does not strand the voice call', async ({ browser }) => {
  const { a, b, bWords } = await setupPair(browser);
  await b.page.clock.install({ time: Date.now() + 30_000 });

  await beingRow(a.page, bWords).getByRole('button', { name: 'open voice' }).click();
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();

  await expect(a.page.locator('.audio-panel')).toContainText('live');
  await expect(b.page.locator('.audio-panel')).toContainText('live');

  await a.page.getByRole('button', { name: 'end', exact: true }).click();
  await expect(a.page.locator('.audio-panel')).toHaveCount(0);
  await expect(b.page.locator('.audio-panel')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});

test('the app starts without a seed and reports offline honestly', async ({ browser }) => {
  const a = await openPage(browser, '?seed=off');
  await expect(a.page.locator('.live')).toHaveText('off');
  await expect(a.page.getByRole('heading', { name: 'The Internet is Here' })).toBeVisible();
  expect(a.errors).toEqual([]);
  await a.context.close();
});

test('pin a channel, filter by its local label, and reopen from the dock', async ({ browser }) => {
  const { a, b } = await setupPair(browser);

  await a.page.getByRole('button', { name: 'pin circle' }).click();
  await a.page.locator('input[name=label]').fill('moon circle');
  await a.page.getByRole('button', { name: 'pin', exact: true }).click();
  await expect(a.page.locator('.dock-item')).toHaveCount(1);

  await a.page.getByRole('button', { name: /landing/ }).click();
  await expect(a.page.locator('.filter-icon')).toBeVisible();
  await a.page.locator('#filter').fill('moon');
  await expect(a.page.locator('.channel-card').filter({ hasText: 'moon circle' })).toBeVisible();

  await a.page.locator('.dock-item').click();
  await expect(a.page.locator('.channel-title')).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('verification and pinned circles survive a reload', async ({ browser }) => {
  const { a, b, bWords } = await setupPair(browser);

  await a.page.getByRole('button', { name: 'pin circle' }).click();
  await a.page.locator('input[name=label]').fill('persisted circle');
  await a.page.getByRole('button', { name: 'pin', exact: true }).click();
  await a.page.getByRole('button', { name: /landing/ }).click();
  await expect(beingRow(a.page, bWords)).toContainText('verified');

  await a.page.reload();
  await expect(a.page.locator('.live')).toHaveText('live');
  await expect(beingRow(a.page, bWords)).toContainText('verified');
  await expect(a.page.locator('.dock-item')).toHaveCount(1);

  await a.context.close();
  await b.context.close();
});

test('a GOING announcement leaves the channel three minutes after its time', async ({ browser }) => {
  const time = futureTime();
  const base = Date.now();
  const aContext = await browser.newContext();
  const aPage = await aContext.newPage();
  await aPage.clock.install({ time: base });
  await aPage.clock.pauseAt(base);
  await aPage.goto('/');
  await aPage.waitForTimeout(1_000);
  await aPage.clock.fastForward(1_000);
  await expect(aPage.locator('.live')).toHaveText('live');

  const bContext = await browser.newContext();
  const bPage = await bContext.newPage();
  await bPage.clock.install({ time: base });
  await bPage.clock.pauseAt(base);
  await bPage.goto('/');
  await bPage.waitForTimeout(1_000);
  await bPage.clock.fastForward(1_000);
  await expect(bPage.locator('.live')).toHaveText('live');

  const channel = await createChannel(aPage, time);
  await expect
    .poll(async () => {
      await bPage.clock.fastForward(250);
      return bPage.locator('.channel-card').count();
    })
    .toBeGreaterThan(0);
  await openChannel(bPage, channel);
  // Put A's clock slightly ahead so B's later messages still fall within the
  // one-minute skew allowance while B still accepts A's earlier GOING.
  await aPage.clock.fastForward(10_000);
  await announce(bPage, time);
  await expect
    .poll(async () => {
      await aPage.clock.fastForward(250);
      return aPage.locator('.time-group').count();
    })
    .toBe(1);

  await aPage.clock.fastForward(3 * 60 * 60 * 1000 + 4 * 60 * 1000);
  await aPage.getByRole('button', { name: 'set a time' }).click();
  await aPage.getByRole('button', { name: 'cancel' }).click();
  await expect(aPage.locator('.time-group')).toHaveCount(0);
  await expect(aPage.locator('.own-announcements')).toHaveCount(0);
  await expect(aPage.getByText('No one else has announced a time here yet.')).toBeVisible();

  await aContext.close();
  await bContext.close();
});

test('a recipient can hold multiple image offers at once', async ({ browser }, testInfo) => {
  const time = futureTime();
  const a = await openPage(browser);
  const b = await openPage(browser);
  const c = await openPage(browser);
  const aWords = await identityWords(a.page);
  const bWords = await identityWords(b.page);
  const cWords = await identityWords(c.page);
  const channel = await createChannel(a.page, time);
  await openChannel(b.page, channel);
  await announce(b.page, time);
  await openChannel(c.page, channel);
  await announce(c.page, time);

  await expect(beingRow(a.page, bWords)).toBeVisible();
  await expect(beingRow(a.page, cWords)).toBeVisible();
  await verify(a.page, bWords);
  await verify(a.page, cWords);
  await verify(b.page, aWords);
  await verify(b.page, cWords);
  await verify(c.page, bWords);

  const file = testInfo.outputPath('one.png');
  writeFileSync(file, PNG);

  await beingRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);

  await beingRow(c.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await c.page.getByRole('button', { name: 'choose image' }).click();
  await c.page.locator('input[type=file]').setInputFiles(file);

  await expect(b.page.locator('.offers .offer')).toHaveCount(2);
  await expect(b.page.locator('.offers .offer').first()).toContainText('verified');

  await b.page.getByRole('button', { name: 'accept', exact: true }).first().click();
  await expect(b.page.locator('img.received-image')).toBeVisible();
  await b.page.getByRole('button', { name: 'dismiss' }).click();
  await b.page.getByRole('button', { name: 'decline', exact: true }).first().click();

  await a.context.close();
  await b.context.close();
  await c.context.close();
});

test('application messages travel only over the WebRTC mesh', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const frames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) => {
      if (typeof event.payload === 'string') frames.push(event.payload);
    });
    socket.on('framereceived', (event) => {
      if (typeof event.payload === 'string') frames.push(event.payload);
    });
  });

  await page.goto('/');
  await expectLive(page);
  await createChannel(page, futureTime());
  await page.waitForTimeout(500);

  const types = frames
    .map((frame) => {
      try {
        return (JSON.parse(frame) as { type?: string }).type ?? '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  expect(types).toContain('bootstrap-offer');
  expect(types).toContain('bootstrap-answer');
  expect(types.every((type) => type.startsWith('bootstrap-'))).toBe(true);
  expect(types.some((type) => type === 'PING' || type === 'GOING' || type === 'SIGNAL')).toBe(false);

  await context.close();
});

test('the seed is a headless WebRTC peer and counts as a live peer', async ({ browser, request }) => {
  const a = await openPage(browser);
  await expectLive(a.page);

  await expect
    .poll(async () => {
      const health = (await (await request.get('/health')).json()) as {
        sessions: number;
        peers: number;
      };
      return health.peers;
    })
    .toBeGreaterThanOrEqual(1);

  const health = (await (await request.get('/health')).json()) as {
    sessions: number;
    peers: number;
  };
  expect(health.sessions).toBeGreaterThanOrEqual(1);
  expect(health.peers).toBeGreaterThanOrEqual(1);

  await a.context.close();
});

test('multiple masks: create, switch, persist, and remove', async ({ browser }) => {
  const a = await openPage(browser);
  const first = await identityWords(a.page);

  await a.page.locator('.identity-chip').click();
  await expect(a.page.getByRole('heading', { name: 'Masks' })).toBeVisible();
  await expect(a.page.locator('.mask-row')).toHaveCount(1);

  await a.page.getByRole('button', { name: 'new mask' }).click();
  await expect(a.page.locator('.mask-row')).toHaveCount(2);
  await expect(a.page.locator('.mask-row.is-active')).toHaveCount(1);
  const second = await identityWords(a.page);
  expect(second).not.toBe(first);
  await expectLive(a.page);

  const firstRow = a.page
    .locator('.mask-row')
    .filter({ hasText: first.split(' ').slice(0, 4).join(' ') });
  await firstRow.getByRole('button', { name: 'switch' }).click();
  await expect.poll(async () => identityWords(a.page)).toBe(first);
  await expect(a.page.locator('.mask-row.is-active')).toHaveCount(1);
  await expectLive(a.page);

  await a.page.reload();
  await expectLive(a.page);
  expect(await identityWords(a.page)).toBe(first);

  await a.page.locator('.identity-chip').click();
  await expect(a.page.locator('.mask-row')).toHaveCount(2);
  await a.page.locator('.mask-row.is-active').getByRole('button', { name: 'remove' }).click();
  await expect(a.page.locator('.mask-row')).toHaveCount(1);
  await expect.poll(async () => identityWords(a.page)).toBe(second);
  await expectLive(a.page);

  await a.page.locator('.mask-row').getByRole('button', { name: 'remove' }).click();
  await expect.poll(async () => identityWords(a.page)).not.toBe(second);
  await expect(a.page.locator('.mask-row')).toHaveCount(1);
  const third = await identityWords(a.page);
  expect([first, second]).not.toContain(third);

  await a.context.close();
});

test('verification is scoped to the active mask', async ({ browser }) => {
  const { a, b, aWords, bWords } = await setupPair(browser);
  await expect(beingRow(a.page, bWords)).toContainText('verified');

  await a.page.locator('.identity-chip').click();
  await a.page.getByRole('button', { name: 'new mask' }).click();
  await expect.poll(async () => identityWords(a.page)).not.toBe(aWords);
  const newWords = await identityWords(a.page);

  await expect(beingRow(a.page, bWords)).toContainText('not verified');
  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toHaveCount(0);
  await expect(a.page.locator('.time-group')).toHaveCount(1);
  await b.page.getByRole('button', { name: /landing/ }).click();
  await expect(beingRow(b.page, newWords)).toBeVisible();

  const firstRow = a.page
    .locator('.mask-row')
    .filter({ hasText: aWords.split(' ').slice(0, 4).join(' ') });
  await firstRow.getByRole('button', { name: 'switch' }).click();
  await expect.poll(async () => identityWords(a.page)).toBe(aWords);
  await expect(beingRow(a.page, bWords)).toContainText('verified');
  await expect(beingRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('I see my active mask in the online list', async ({ browser }) => {
  const a = await openPage(browser);
  const first = await identityWords(a.page);
  const selfRow = beingRow(a.page, first);

  await expect(a.page.locator('.masthead-name')).toHaveText('rendezvous');
  await expect(a.page.locator('.masthead-stamp svg')).toBeVisible();
  await expect(a.page.locator('.masthead-link')).toHaveAttribute('href', 'https://instanthero.ca');
  await expect(a.page.locator('.masthead-link')).toHaveAttribute('target', '_blank');
  const beingEmoji = (await selfRow.locator('.being-emoji').innerText()).trim();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  expect([...segmenter.segment(beingEmoji)].length).toBeGreaterThanOrEqual(6);
  const beingEmojiStyle = await selfRow.locator('.being-emoji').evaluate((element) => {
    const style = getComputedStyle(element);
    return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow };
  });
  expect(beingEmojiStyle).toEqual({ whiteSpace: 'normal', textOverflow: 'clip' });
  await expect(selfRow).toBeVisible();
  await expect(selfRow).toContainText('me · active mask');
  await expect(selfRow).toContainText('here now');
  await expect(selfRow.getByRole('button', { name: 'send photo' })).toHaveCount(0);
  await expect(a.page.locator('.hero .orbit')).toBeVisible();

  await selfRow.locator('.being-main').click();
  await expect(a.page.getByRole('heading', { name: 'Masks' })).toBeVisible();
  const fullWords = a.page.locator('.identity-words.full.mono').first();
  const fullText = (await fullWords.innerText()).trim();
  expect(fullText.split(/\s+/)).toHaveLength(8);
  const fullStyle = await fullWords.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
    };
  });
  expect(fullStyle).toEqual({
    whiteSpace: 'normal',
    overflow: 'visible',
    textOverflow: 'clip',
  });
  await a.page.getByRole('button', { name: 'new mask' }).click();
  await expect.poll(async () => identityWords(a.page)).not.toBe(first);
  const second = await identityWords(a.page);
  await a.page.locator('.modal-actions [data-action="close-modal"]').click();

  await expect(beingRow(a.page, second)).toContainText('me · active mask');
  await expect(a.page.locator('.being-row').filter({ hasText: first })).toHaveCount(0);

  await createChannel(a.page, futureTime());
  await expect(a.page.locator('.own-announcements')).toContainText('You set this rendezvous for');
  await expect(a.page.locator('.time-group')).toHaveCount(0);
  await expect(a.page.locator('.being-row')).toHaveCount(0);
  await expect(a.page.locator('.orbit')).toHaveCount(0);

  await a.context.close();
});

test('the mask switcher shows the full words and emoji on a small screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.live')).toHaveText(/live|off/);
  await expect(page.locator('.traffic-signalling .signal-toggle')).toBeVisible();
  expect(
    await page
      .locator('.traffic-widget')
      .evaluate((widget) => widget.scrollWidth > widget.clientWidth + 1),
  ).toBe(false);
  await page.locator('.identity-chip').click();
  await expect(page.getByRole('heading', { name: 'Masks' })).toBeVisible();

  const fullEmoji = page.locator('.identity-words.full:not(.mono)').first();
  const fullWords = page.locator('.identity-words.full.mono').first();
  const rowEmoji = page.locator('.mask-row .mask-emoji').first();
  const rowWords = page.locator('.mask-row .mask-copy strong').first();
  await expect(fullEmoji).toBeVisible();
  await expect(fullWords).toBeVisible();

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  expect([...segmenter.segment((await fullEmoji.innerText()).trim())]).toHaveLength(11);
  expect([...segmenter.segment((await rowEmoji.innerText()).trim())]).toHaveLength(11);
  expect((await fullWords.innerText()).trim().split(/\s+/)).toHaveLength(8);
  expect((await rowWords.innerText()).trim().split(/\s+/)).toHaveLength(8);

  const layout = await page.evaluate(() => {
    const modal = document.querySelector<HTMLElement>('.modal')!;
    const row = document.querySelector<HTMLElement>('.mask-row')!;
    const words = document.querySelector<HTMLElement>('.mask-row .mask-copy strong')!;
    const style = (element: HTMLElement) => ({
      display: getComputedStyle(element).display,
      whiteSpace: getComputedStyle(element).whiteSpace,
      textOverflow: getComputedStyle(element).textOverflow,
    });
    return {
      modal: {
        clientHeight: modal.clientHeight,
        scrollHeight: modal.scrollHeight,
        overflowY: getComputedStyle(modal).overflowY,
      },
      emoji: style(document.querySelector<HTMLElement>('.identity-words.full:not(.mono)')!),
      fullWords: style(document.querySelector<HTMLElement>('.identity-words.full.mono')!),
      rowWords: style(words),
      rowClipped: row.scrollWidth > row.clientWidth + 1,
    };
  });

  expect(layout.emoji).toEqual({ display: 'block', whiteSpace: 'normal', textOverflow: 'clip' });
  expect(layout.fullWords).toEqual({ display: 'block', whiteSpace: 'normal', textOverflow: 'clip' });
  expect(layout.rowWords).toEqual({ display: 'block', whiteSpace: 'normal', textOverflow: 'clip' });
  expect(layout.rowClipped).toBe(false);
  expect(layout.modal.overflowY).toBe('auto');
  expect(layout.modal.clientHeight).toBeLessThanOrEqual(568);
  await page.locator('.modal').evaluate((modal) => {
    modal.scrollTop = modal.scrollHeight;
  });
  await expect(page.locator('.modal-actions [data-action="close-modal"]')).toBeInViewport();
  expect(errors).toEqual([]);
  await context.close();
});

test('the landing orbit survives a list update', async ({ browser }) => {
  const a = await openPage(browser);
  await expect(a.page.locator('.hero .orbit')).toBeVisible();
  await a.page.waitForTimeout(2500);
  const before = await orbitProgress(a.page);
  expect(before).toBeGreaterThan(5);

  await a.page.locator('.hero .orbit').evaluate((orbit) => {
    orbit.dataset.renderProbe = 'kept';
  });
  await a.page.locator('#filter').fill('x');
  await expect(a.page.locator('.hero .orbit')).toHaveAttribute('data-render-probe', 'kept');

  const after = await orbitProgress(a.page);
  expect(after).toBeGreaterThan(before - 1.5);
  expect(a.errors).toEqual([]);
  await a.context.close();
});

test('the clock tick does not rebuild the landing', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base);
  await page.goto('/');
  await page.waitForTimeout(1_000);
  await page.clock.fastForward(1_000);
  await expect(page.locator('.live')).toHaveText(/live|off/);
  await expect(page.locator('.hero .orbit')).toBeVisible();

  const filter = page.locator('#filter');
  await filter.focus();
  await filter.evaluate((element) => {
    element.dataset.tickProbe = 'kept';
  });

  await page.clock.fastForward(11_000);

  await expect(page.locator('#filter')).toHaveAttribute('data-tick-probe', 'kept');
  await expect(page.locator('#filter')).toBeFocused();
  await context.close();
});

test('beings lead the landing and tabs switch lists on small screens', async ({ browser }) => {
  const desktop = await browser.newContext();
  const desktopPage = await desktop.newPage();
  await desktopPage.goto('/');
  await expect(desktopPage.locator('.live')).toHaveText(/live|off/);

  const desktopHumans = await desktopPage.locator('[data-region="beings-panel"]').boundingBox();
  const desktopChannels = await desktopPage.locator('[data-region="channels-panel"]').boundingBox();
  expect(desktopHumans).not.toBeNull();
  expect(desktopChannels).not.toBeNull();
  expect(desktopHumans!.x).toBeLessThan(desktopChannels!.x);
  await expect(desktopPage.locator('.landing-tabs')).toBeHidden();
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await mobile.newPage();
  await page.goto('/');
  await expect(page.locator('.live')).toHaveText(/live|off/);

  const beings = page.locator('[data-region="beings-panel"]');
  const channels = page.locator('[data-region="channels-panel"]');
  await expect(page.locator('.landing-tabs')).toBeVisible();
  await expect(beings).toBeVisible();
  await expect(channels).toBeHidden();
  await expect(page.getByRole('button', { name: 'Beings', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Rendezvous', exact: true }).click();
  await expect(channels).toBeVisible();
  await expect(beings).toBeHidden();
  await expect(page.getByRole('button', { name: 'Rendezvous', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Beings', exact: true }).click();
  await expect(beings).toBeVisible();
  await expect(channels).toBeHidden();

  await mobile.close();
});

test('landing rendezvous emoji prefixes are complete and unique', async ({ browser }) => {
  const a = await openPage(browser);
  for (let index = 0; index < 3; index += 1) {
    await createChannel(a.page, futureTime());
    await a.page.getByRole('button', { name: /landing/ }).click();
  }

  const values = (await a.page.locator('.channel-card .channel-emoji').allInnerTexts()).map(
    (value) => value.trim(),
  );
  expect(values.length).toBeGreaterThanOrEqual(3);
  expect(new Set(values).size).toBe(values.length);

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const value of values) {
    expect(value).not.toContain('…');
    const length = [...segmenter.segment(value)].length;
    expect(length).toBeGreaterThanOrEqual(3);
    expect(length).toBeLessThanOrEqual(11);
  }

  await a.context.close();
});
