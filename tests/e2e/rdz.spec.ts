import { test, expect, type Browser, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

function futureTime(): string {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function openPage(browser: Browser, query = ''): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page; errors: string[] }> {
  const context = await browser.newContext();
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
  await page.getByRole('button', { name: 'set a time' }).click();
  await page.locator('input[name=time]').fill(time);
  await page.getByRole('button', { name: 'announce time' }).click();
  await expect(page.locator('.time-group').first()).toBeVisible();
}

function humanRow(page: Page, shortWords: string) {
  return page.locator('.human-row').filter({ hasText: shortWords }).first();
}

async function verify(page: Page, shortWords: string): Promise<void> {
  const row = humanRow(page, shortWords);
  await row.locator('.human-main').click();
  await page.getByRole('button', { name: 'mark as verified' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

async function setupPair(browser: Browser): Promise<{
  a: Awaited<ReturnType<typeof openPage>>;
  b: Awaited<ReturnType<typeof openPage>>;
  aWords: string;
  bWords: string;
  channel: string;
}> {
  const time = futureTime();
  const a = await openPage(browser);
  const b = await openPage(browser);
  await expectLive(a.page);
  await expectLive(b.page);
  const aWords = await identityWords(a.page);
  const bWords = await identityWords(b.page);
  const channel = await createChannel(a.page, time);
  await openChannel(b.page, channel);
  await announce(b.page, time);
  await expect(humanRow(a.page, bWords)).toBeVisible();
  await verify(a.page, bWords);
  await verify(b.page, aWords);
  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toBeVisible();
  return { a, b, aWords, bWords, channel };
}

test('presence, channel, verification, and the unverified gate', async ({ browser }) => {
  const time = futureTime();
  const a = await openPage(browser);
  const b = await openPage(browser);
  await expectLive(a.page);
  await expectLive(b.page);
  const aWords = await identityWords(a.page);
  const bWords = await identityWords(b.page);

  await expect(humanRow(a.page, bWords)).toBeVisible();
  await expect(humanRow(b.page, aWords)).toBeVisible();

  const channel = await createChannel(a.page, time);
  await openChannel(b.page, channel);
  await announce(b.page, time);

  await expect(humanRow(a.page, bWords)).toBeVisible();
  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toHaveCount(0);
  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'verify' })).toBeVisible();

  await verify(a.page, bWords);
  await verify(b.page, aWords);

  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toBeVisible();
  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'open voice' })).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('image consent, direct transfer, save, dismiss, reuse, and decline', async ({ browser }, testInfo) => {
  const { a, b, bWords } = await setupPair(browser);
  const file = testInfo.outputPath('one.png');
  writeFileSync(file, PNG);

  await humanRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);

  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await expect(b.page.locator('.offer')).toContainText(/\d+(\.\d+)? (B|KB|MB)/);
  await expect(b.page.locator('.offer img')).toHaveCount(0);
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(b.page.locator('img.received-image')).toBeVisible();
  await expect(b.page.locator('a[download]')).toBeVisible();
  await b.page.getByRole('button', { name: 'dismiss' }).click();
  await expect(b.page.locator('img.received-image')).toHaveCount(0);

  await humanRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await expect(a.page.getByRole('button', { name: /reuse last image/ })).toBeVisible();
  await a.page.getByRole('button', { name: /reuse last image/ }).click();
  await expect(b.page.getByRole('button', { name: 'decline', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'decline', exact: true }).click();
  await expect(a.page.getByText('The image was declined.')).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('one-minute audio request, consent, live panel, and end', async ({ browser }) => {
  const { a, b, bWords } = await setupPair(browser);

  await humanRow(a.page, bWords).getByRole('button', { name: 'open voice' }).click();
  await expect(b.page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
  await b.page.getByRole('button', { name: 'accept', exact: true }).click();

  await expect(a.page.locator('.audio-panel')).toBeVisible();
  await expect(b.page.locator('.audio-panel')).toBeVisible();
  await expect(a.page.locator('.audio-panel')).toContainText('live');
  await expect(a.page.locator('.pink-bar')).toBeVisible();
  await expect(a.page.locator('.pink-bar')).not.toContainText(/\d/);

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
  await expect(humanRow(a.page, bWords)).toContainText('verified');

  await a.page.reload();
  await expect(a.page.locator('.live')).toHaveText('live');
  await expect(humanRow(a.page, bWords)).toContainText('verified');
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
  // Put A's clock ahead so strict no-future validation accepts B's later
  // messages while B still accepts A's earlier GOING.
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

  await expect(humanRow(a.page, bWords)).toBeVisible();
  await expect(humanRow(a.page, cWords)).toBeVisible();
  await verify(a.page, bWords);
  await verify(a.page, cWords);
  await verify(b.page, aWords);
  await verify(b.page, cWords);
  await verify(c.page, bWords);

  const file = testInfo.outputPath('one.png');
  writeFileSync(file, PNG);

  await humanRow(a.page, bWords).getByRole('button', { name: 'send photo' }).click();
  await a.page.getByRole('button', { name: 'choose image' }).click();
  await a.page.locator('input[type=file]').setInputFiles(file);

  await humanRow(c.page, bWords).getByRole('button', { name: 'send photo' }).click();
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
  await expect(humanRow(a.page, bWords)).toContainText('verified');

  await a.page.locator('.identity-chip').click();
  await a.page.getByRole('button', { name: 'new mask' }).click();
  await expect.poll(async () => identityWords(a.page)).not.toBe(aWords);
  const newWords = await identityWords(a.page);

  await expect(humanRow(a.page, bWords)).toContainText('not verified');
  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toHaveCount(0);
  await expect(a.page.locator('.time-group')).toHaveCount(1);
  await b.page.getByRole('button', { name: /landing/ }).click();
  await expect(humanRow(b.page, newWords)).toBeVisible();

  const firstRow = a.page
    .locator('.mask-row')
    .filter({ hasText: aWords.split(' ').slice(0, 4).join(' ') });
  await firstRow.getByRole('button', { name: 'switch' }).click();
  await expect.poll(async () => identityWords(a.page)).toBe(aWords);
  await expect(humanRow(a.page, bWords)).toContainText('verified');
  await expect(humanRow(a.page, bWords).getByRole('button', { name: 'send photo' })).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('I see my active mask in the online list', async ({ browser }) => {
  const a = await openPage(browser);
  const first = await identityWords(a.page);
  const selfRow = humanRow(a.page, first);

  await expect(a.page.locator('.masthead-name')).toHaveText('rendezvous');
  await expect(a.page.locator('.masthead-stamp svg')).toBeVisible();
  await expect(a.page.locator('.brand-mark svg')).toBeVisible();
  const humanEmoji = (await selfRow.locator('.human-emoji').innerText()).trim();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  expect([...segmenter.segment(humanEmoji)].length).toBeGreaterThanOrEqual(6);
  const humanEmojiStyle = await selfRow.locator('.human-emoji').evaluate((element) => {
    const style = getComputedStyle(element);
    return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow };
  });
  expect(humanEmojiStyle).toEqual({ whiteSpace: 'normal', textOverflow: 'clip' });
  await expect(selfRow).toBeVisible();
  await expect(selfRow).toContainText('me · active mask');
  await expect(selfRow).toContainText('here now');
  await expect(selfRow.getByRole('button', { name: 'send photo' })).toHaveCount(0);
  await expect(a.page.locator('.hero .orbit')).toBeVisible();

  await selfRow.locator('.human-main').click();
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

  await expect(humanRow(a.page, second)).toContainText('me · active mask');
  await expect(a.page.locator('.human-row').filter({ hasText: first })).toHaveCount(0);

  await createChannel(a.page, futureTime());
  await expect(a.page.locator('.own-announcements')).toContainText('You set this rendezvous for');
  await expect(a.page.locator('.time-group')).toHaveCount(0);
  await expect(a.page.locator('.human-row')).toHaveCount(0);
  await expect(a.page.locator('.orbit')).toHaveCount(0);

  await a.context.close();
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
