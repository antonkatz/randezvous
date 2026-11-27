import { expect, test } from '@playwright/test';
import { createRendezvousLink, setName } from './helpers';

test('an unacknowledged join is retried until the inviter saves the human', async ({
  browser,
}) => {
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await mobileContext.newPage();
  const desktop = await desktopContext.newPage();

  // Drop the first join request as if a mobile socket had lost the message.
  // The server must keep retrying until the inviter acknowledges it.
  await mobile.routeWebSocket(/\/signal$/u, (socket) => {
    const server = socket.connectToServer();
    let dropped = false;
    server.onMessage((message) => {
      if (
        !dropped &&
        typeof message === 'string' &&
        message.includes('"type":"invite:request"')
      ) {
        dropped = true;
        return;
      }
      socket.send(message);
    });
  });

  await mobile.goto('/');
  await setName(mobile, 'Mobile');
  await desktop.goto('/');
  await setName(desktop, 'Desktop');

  const { link } = await createRendezvousLink(mobile);
  await desktop.goto(link);

  await expect(desktop.locator('#humans-list')).toContainText('Mobile');
  await expect(mobile.locator('#humans-list')).toContainText('Desktop', { timeout: 20_000 });
  await expect(desktop.locator('#toast-region')).toContainText(/accepted your invitation/iu);

  await mobileContext.close();
  await desktopContext.close();
});
