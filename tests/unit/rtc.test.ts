import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, createIdentity } from '../../src/rdz/crypto';
import { RtcManager } from '../../src/rdz/rtc';
import type { AudioSession, SignalKind } from '../../src/rdz/types';

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
    onAudioNotice: () => undefined,
  });
}

async function audioManager(
  getUserMedia: () => Promise<MediaStream> = () => new Promise<MediaStream>(() => undefined),
) {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(getUserMedia) } });
  const identity = await createIdentity();
  const peer = await createIdentity();
  const signals: Array<{
    target: string;
    channelId: string;
    signal: SignalKind;
    transferId: string;
  }> = [];
  const states: Array<AudioSession | null> = [];
  const notices: string[] = [];
  const rtc = new RtcManager(identity, {
    sendSignal: (target, channelId, signal, transferId) => {
      signals.push({ target, channelId, signal, transferId });
    },
    isVerified: () => true,
    canAcceptChannel: () => true,
    onImageOffer: () => undefined,
    onImageProgress: () => undefined,
    onImageComplete: () => undefined,
    onImageFailed: () => undefined,
    onAudioRequest: () => undefined,
    onAudioState: (session) => states.push(session),
    onAudioNotice: (message) => notices.push(message),
  });
  return { rtc, identity, peer, signals, states, notices };
}

async function signalEnvelope(
  peer: Awaited<ReturnType<typeof createIdentity>>,
  target: string,
  signal: SignalKind,
  transferId: string,
) {
  return createEnvelope(peer, {
    kind: 'SIGNAL',
    target,
    channelId: 'channel',
    signal,
    transferId,
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

describe('audio permission timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the voice panel while either microphone prompt is open', async () => {
    const { rtc, identity, peer, signals, states } = await audioManager();
    await rtc.requestAudio(peer.humanId, 'channel');
    const request = signals.find((entry) => entry.signal === 'audio-request');
    expect(request).toBeDefined();
    expect(states.at(-1)?.phase).toBe('requesting');

    const accepting = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-accepting',
      request!.transferId,
    );
    await rtc.handleSignal(accepting);
    expect(states.at(-1)?.phase).toBe('connecting');

    // The recipient is still at their own microphone prompt.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(states.at(-1)?.phase).toBe('connecting');

    const accept = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-accept',
      request!.transferId,
    );
    void rtc.handleSignal(accept);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)?.phase).toBe('connecting');

    // The initiator's microphone prompt is open too.
    await vi.advanceTimersByTimeAsync(121_000);
    expect(states.at(-1)?.phase).toBe('connecting');
    expect(rtc.busyPeers().has(peer.humanId)).toBe(true);
  });

  it('reports an unanswered voice request instead of waiting forever', async () => {
    const { rtc, peer, states, notices } = await audioManager();
    await rtc.requestAudio(peer.humanId, 'channel');

    await vi.advanceTimersByTimeAsync(120_001);

    expect(notices).toEqual(['No answer to the voice request.']);
    expect(states.at(-1)).toBeNull();
    expect(rtc.busyPeers().has(peer.humanId)).toBe(false);
  });

  it('reports when the recipient never finishes granting the microphone', async () => {
    const { rtc, identity, peer, signals, states, notices } = await audioManager();
    await rtc.requestAudio(peer.humanId, 'channel');
    const request = signals.find((entry) => entry.signal === 'audio-request');
    const accepting = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-accepting',
      request!.transferId,
    );

    await rtc.handleSignal(accepting);
    await vi.advanceTimersByTimeAsync(120_001);

    expect(notices).toEqual([
      'The other person did not finish starting their microphone.',
    ]);
    expect(states.at(-1)).toBeNull();
  });

  it('explains a denied microphone instead of closing silently', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { rtc, identity, peer, signals, states, notices } = await audioManager(() =>
      Promise.reject(denied),
    );
    await rtc.requestAudio(peer.humanId, 'channel');
    const request = signals.find((entry) => entry.signal === 'audio-request');
    const accept = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-accept',
      request!.transferId,
    );

    await rtc.handleSignal(accept);

    expect(notices).toEqual(['Microphone access was not allowed.']);
    expect(signals.some((entry) => entry.signal === 'audio-decline')).toBe(true);
    expect(states.at(-1)).toBeNull();
  });

  it('tells the recipient when their microphone is denied after accepting', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { rtc, identity, peer, signals, states, notices } = await audioManager(() =>
      Promise.reject(denied),
    );
    const request = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-request',
      'incoming-transfer',
    );
    await rtc.handleSignal(request);

    await rtc.acceptAudio('incoming-transfer');

    expect(signals.some((entry) => entry.signal === 'audio-accepting')).toBe(true);
    expect(signals.some((entry) => entry.signal === 'audio-decline')).toBe(true);
    expect(notices).toEqual(['Microphone access was not allowed.']);
    expect(states.at(-1)).toBeNull();
  });

  it('tells the requester when the voice request is declined', async () => {
    const { rtc, identity, peer, signals, states, notices } = await audioManager();
    await rtc.requestAudio(peer.humanId, 'channel');
    const request = signals.find((entry) => entry.signal === 'audio-request');
    const decline = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-decline',
      request!.transferId,
    );

    await rtc.handleSignal(decline);

    expect(notices).toEqual(['The voice request was declined.']);
    expect(states.at(-1)).toBeNull();
    expect(rtc.busyPeers().has(peer.humanId)).toBe(false);
  });

  it('tells the remaining human when the other one ends a pending request', async () => {
    const { rtc, identity, peer, signals, states, notices } = await audioManager();
    await rtc.requestAudio(peer.humanId, 'channel');
    const request = signals.find((entry) => entry.signal === 'audio-request');
    const end = await signalEnvelope(
      peer,
      identity.humanId,
      'audio-end',
      request!.transferId,
    );

    await rtc.handleSignal(end);

    expect(notices).toEqual(['The voice request ended.']);
    expect(states.at(-1)).toBeNull();
  });
});
