import { describe, expect, it } from 'vitest';
import { createIdentity } from '../../src/rdz/crypto';
import { RtcManager } from '../../src/rdz/rtc';

async function manager(): Promise<RtcManager> {
  const identity = await createIdentity();
  return new RtcManager(identity, {
    sendSignal: () => undefined,
    isVerified: () => true,
    canAcceptChannel: () => true,
    onImageOffer: () => undefined,
    onImageProgress: () => undefined,
    onImageComplete: () => undefined,
    onImageFailed: () => undefined,
    onAudioRequest: () => undefined,
    onAudioState: () => undefined,
  });
}

describe('image validation', () => {
  it('rejects non-image files before opening a connection', async () => {
    const rtc = await manager();
    expect(() =>
      rtc.sendImage('peer', 'channel', new File(['hello'], 'note.txt', { type: 'text/plain' })),
    ).toThrow('Only PNG, JPEG, WebP, GIF, or AVIF images are allowed.');
  });

  it('rejects SVG and other active-content image types', async () => {
    const rtc = await manager();
    expect(() =>
      rtc.sendImage('peer', 'channel', new File(['<svg/>'], 'evil.svg', { type: 'image/svg+xml' })),
    ).toThrow('Only PNG, JPEG, WebP, GIF, or AVIF images are allowed.');
  });

  it('rejects images larger than 25 MiB before opening a connection', async () => {
    const rtc = await manager();
    const file = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'huge.png', {
      type: 'image/png',
    });
    expect(() => rtc.sendImage('peer', 'channel', file)).toThrow(
      'Images must be 25 MB or smaller.',
    );
  });
});
