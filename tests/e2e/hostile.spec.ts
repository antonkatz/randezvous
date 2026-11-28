import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'werift';
import {
  createEnvelope,
  createIdentity,
  signText,
} from '../../src/rdz/crypto';
import { randomRendezvousId } from '../../src/rdz/ids';
import { meshHelloBody } from '../../src/rdz/mesh-control';

const SEED_PORT = process.env.E2E_PORT ?? '8799';

/**
 * A real headless WebRTC peer that behaves like any other participant. It is
 * used to publish hostile but correctly signed envelopes through the seed,
 * exactly as an anonymous attendee could.
 */
interface HostilePeer {
  send: (value: unknown) => void;
  close: () => void;
}

async function connectHostilePeer(): Promise<HostilePeer> {
  const identity = await createIdentity();
  const socket = new WebSocket(`ws://127.0.0.1:${SEED_PORT}/signal`);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel('rdz');
  const welcomed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hostile peer bootstrap timed out')), 30_000);
    channel.onMessage.subscribe(async (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      let message: { type?: string; nonce?: string };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.type === 'mesh-challenge' && message.nonce) {
        const signature = await signText(identity.privateKey, meshHelloBody(message.nonce));
        channel.send(
          JSON.stringify({
            type: 'mesh-hello',
            humanId: identity.humanId,
            publicKey: identity.publicKey,
            nonce: message.nonce,
            signature,
          }),
        );
      } else if (message.type === 'mesh-welcome') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  socket.on('message', async (raw) => {
    let message: { type?: string; sdp?: unknown; candidate?: unknown };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === 'bootstrap-answer' && message.sdp) {
      await pc.setRemoteDescription(message.sdp).catch(() => undefined);
    } else if (message.type === 'bootstrap-ice' && message.candidate) {
      await pc.addIceCandidate(message.candidate).catch(() => undefined);
    }
  });
  pc.onIceCandidate.subscribe((candidate) => {
    if (!candidate || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'bootstrap-ice', candidate: candidate.toJSON() }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify({ type: 'bootstrap-offer', sdp: pc.localDescription }));
  await welcomed;
  return {
    send: (value) => channel.send(JSON.stringify(value)),
    close: () => {
      try {
        pc.close();
      } catch {
        // Ignore.
      }
      socket.close();
    },
  };
}

async function openVictim(
  browser: Browser,
): Promise<{ page: Page; errors: string[]; context: BrowserContext }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.live')).toHaveText('live', { timeout: 20_000 });
  return { page, errors, context };
}

/**
 * Writes an envelope straight into the app's local message store, as a build
 * from before the fix would have persisted it. The board must ignore and purge
 * it rather than render it.
 */
async function seedStoredEnvelope(page: Page, envelope: unknown): Promise<void> {
  await page.evaluate(async (value) => {
    const request = indexedDB.open('rdz', 3);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const id = 'poisoned-envelope';
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put({ id, envelope: value });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, envelope);
}

function futureTime(): string {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

test('a malformed rendezvous id is dropped and never bricks the board', async ({ browser }) => {
  const victim = await openVictim(browser);
  const other = await openVictim(browser);
  const hostile = await connectHostilePeer();
  hostile.send(
    await createEnvelope(await createIdentity(), {
      kind: 'GOING',
      rendezvousId: 'not-a-valid-id',
      scheduledAt: Date.now() + 60 * 60_000,
    }),
  );

  // The renderer must stay healthy on both boards.
  for (const page of [victim.page, other.page]) {
    await page.locator('#filter').fill('x');
    await page.locator('#filter').fill('');
  }

  // A fresh rendezvous still works, which proves the render loop survived.
  await victim.page.getByRole('button', { name: 'Set a rendezvous' }).click();
  await victim.page.locator('input[name=time]').fill(futureTime());
  await victim.page.getByRole('button', { name: 'create & go' }).click();
  await expect(victim.page.locator('.channel-title')).toBeVisible();

  expect(victim.errors).toEqual([]);
  expect(other.errors).toEqual([]);

  hostile.close();
  await victim.context.close();
  await other.context.close();
});

test('a far-future rendezvous is dropped instead of filling the seed cache', async ({ request }) => {
  const before = (await (await request.get('/health')).json()) as { cached: number };
  const hostile = await connectHostilePeer();
  const identity = await createIdentity();
  for (let index = 0; index < 20; index += 1) {
    hostile.send(
      await createEnvelope(identity, {
        kind: 'GOING',
        rendezvousId: randomRendezvousId(),
        scheduledAt: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
      }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  const after = (await (await request.get('/health')).json()) as { cached: number };

  // All 20 announcements are beyond the horizon, so none may be cached. Allow
  // at most one unrelated PING from a concurrently closing peer.
  expect(after.cached - before.cached).toBeLessThanOrEqual(1);
  hostile.close();
});

test('a poisoned envelope already in local storage is purged instead of rendered', async ({ browser }) => {
  const victim = await openVictim(browser);
  const poisoned = await createEnvelope(await createIdentity(), {
    kind: 'GOING',
    rendezvousId: 'not-a-valid-id',
    scheduledAt: Date.now() + 60 * 60_000,
  });
  await seedStoredEnvelope(victim.page, poisoned);
  // Reload the way a previously bricked visitor would.
  await victim.page.reload();
  await expect(victim.page.locator('.live')).toHaveText('live', { timeout: 20_000 });

  // The board must stay responsive: filter input and a fresh rendezvous work.
  await victim.page.locator('#filter').fill('x');
  await victim.page.locator('#filter').fill('');
  await victim.page.getByRole('button', { name: 'Set a rendezvous' }).click();
  await victim.page.locator('input[name=time]').fill(futureTime());
  await victim.page.getByRole('button', { name: 'create & go' }).click();
  await expect(victim.page.locator('.channel-title')).toBeVisible();
  expect(victim.errors).toEqual([]);

  // The invalid row is deleted during startup, not merely hidden at render time.
  const ids = await victim.page.evaluate(async () => {
    const request = indexedDB.open('rdz', 3);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<Array<{ id: string }>>((resolve, reject) => {
      const read = db.transaction('messages', 'readonly').objectStore('messages').getAll();
      read.onsuccess = () => resolve(read.result as Array<{ id: string }>);
      read.onerror = () => reject(read.error);
    });
    db.close();
    return rows.map((row) => row.id);
  });
  expect(ids).not.toContain('poisoned-envelope');

  await victim.context.close();
});
