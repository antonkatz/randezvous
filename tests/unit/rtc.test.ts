import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, createIdentity } from '../../src/rdz/crypto';
import { RtcManager } from '../../src/rdz/rtc';
import type {
  AudioSession,
  ImageTransferProgress,
  IncomingImageOffer,
  SignalKind,
} from '../../src/rdz/types';

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Array<string | ArrayBuffer | ArrayBufferView> = [];

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channels: FakeDataChannel[] = [];
  addedIce: RTCIceCandidateInit[] = [];

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    // Real browsers reject an answer once the connection is already stable.
    if (description.type === 'answer' && this.remoteDescription) {
      throw new Error('InvalidStateError');
    }
    this.remoteDescription = description;
    if (description.type !== 'offer') return;
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    const event = new Event('datachannel') as Event & { channel: RTCDataChannel };
    Object.defineProperty(event, 'channel', { value: channel as unknown as RTCDataChannel });
    this.dispatchEvent(event);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedIce.push(candidate);
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

interface CapturedSignal {
  target: string;
  channelId: string;
  signal: SignalKind;
  transferId: string;
  data?: unknown;
}

function sentBinaryBytes(channel: FakeDataChannel): number {
  return channel.sent.reduce(
    (total, data) => total + (typeof data === 'string' ? 0 : data.byteLength),
    0,
  );
}

async function imageManager() {
  const identity = await createIdentity();
  const peer = await createIdentity();
  const signals: CapturedSignal[] = [];
  const progress: ImageTransferProgress[] = [];
  const failed: string[] = [];
  const offers: IncomingImageOffer[] = [];
  const completed: string[] = [];
  const rtc = new RtcManager(identity, {
    sendSignal: (target, channelId, signal, transferId, data) => {
      signals.push({ target, channelId, signal, transferId, ...(data === undefined ? {} : { data }) });
    },
    isVerified: () => true,
    canAcceptChannel: () => true,
    onImageOffer: (offer) => offers.push(offer),
    onImageProgress: (entry) => progress.push(entry),
    onImageComplete: (transferId) => completed.push(transferId),
    onImageFailed: (_transferId, message) => failed.push(message),
    onAudioRequest: () => undefined,
    onAudioState: () => undefined,
    onAudioNotice: () => undefined,
  });
  return { rtc, identity, peer, signals, progress, failed, offers, completed };
}

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
  data?: unknown,
) {
  return createEnvelope(peer, {
    kind: 'SIGNAL',
    target,
    channelId: 'channel',
    signal,
    transferId,
    ...(data === undefined ? {} : { data }),
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

describe('image connection mechanics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    FakePeerConnection.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('applies image ICE candidates that arrive before the offer', async () => {
    const { rtc, identity, peer, signals } = await imageManager();
    const transferId = 'incoming-transfer';
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-offer', transferId, { sizeMb: 0.1 }),
    );
    await rtc.acceptImage(transferId);
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'ice', transferId, {
        candidate: { candidate: 'early' },
      }),
    );

    expect(FakePeerConnection.instances).toHaveLength(0);

    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'offer', transferId, {
        sdp: { type: 'offer', sdp: 'v=0' },
      }),
    );

    const pc = FakePeerConnection.instances[0]!;
    expect(pc.addedIce).toEqual([{ candidate: 'early' }]);
    expect(signals.some((entry) => entry.signal === 'answer')).toBe(true);
    rtc.stop();
  });

  it('applies outgoing ICE candidates that arrive before the answer', async () => {
    const { rtc, identity, peer, signals } = await imageManager();
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array([1, 2, 3])], 'one.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    expect(offer).toBeDefined();

    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId),
    );
    const pc = FakePeerConnection.instances[0]!;

    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'ice', offer!.transferId, {
        candidate: { candidate: 'early-out' },
      }),
    );
    expect(pc.addedIce).toEqual([]);

    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'answer', offer!.transferId, {
        sdp: { type: 'answer', sdp: 'v=0' },
      }),
    );

    expect(pc.addedIce).toEqual([{ candidate: 'early-out' }]);
    rtc.stop();
  });

  it('fails an accepted image that never connects and tells the sender', async () => {
    const { rtc, identity, peer, signals, failed, progress } = await imageManager();
    const transferId = 'never-connects';
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-offer', transferId, { sizeMb: 0.1 }),
    );
    await rtc.acceptImage(transferId);
    expect(progress.at(-1)?.phase).toBe('connecting');

    await vi.advanceTimersByTimeAsync(30_001);

    expect(failed).toEqual(['The direct connection timed out.']);
    expect(signals.find((entry) => entry.signal === 'image-decline')?.data).toEqual({
      reason: 'The direct connection timed out.',
    });
    expect(rtc.busyPeers().has(peer.humanId)).toBe(false);
    rtc.stop();
  });

  it('flushes the ack before closing the receiving connection', async () => {
    const { rtc, identity, peer, completed } = await imageManager();
    const transferId = 'ack-transfer';
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-offer', transferId, { sizeMb: 0.1 }),
    );
    await rtc.acceptImage(transferId);
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'offer', transferId, {
        sdp: { type: 'offer', sdp: 'v=0' },
      }),
    );

    const pc = FakePeerConnection.instances[0]!;
    const channel = pc.channels[0]!;
    channel.receive(JSON.stringify({ type: 'meta', size: 3, mime: 'image/png' }));
    channel.receive(new Uint8Array([1, 2, 3]).buffer);
    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toEqual([transferId]);
    expect(channel.sent).toContain(JSON.stringify({ type: 'ack' }));
    expect(
      channel.sent.some((data) => typeof data === 'string' && data.includes('"type":"window"')),
    ).toBe(false);
    expect(pc.connectionState).not.toBe('closed');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pc.connectionState).toBe('closed');
    rtc.stop();
  });

  it('shows the receiver reason when the connection closes before the transfer', async () => {
    const { rtc, identity, peer, signals, progress } = await imageManager();
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array([1, 2, 3])], 'one.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId),
    );
    const channel = FakePeerConnection.instances[0]!.channels[0]!;
    channel.readyState = 'closed';
    channel.dispatchEvent(new Event('close'));

    // The signed decline lands a moment after the raw transport close.
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-decline', offer!.transferId, {
        reason: 'The direct connection timed out.',
      }),
    );

    expect(progress.at(-1)?.phase).toBe('failed');
    expect(progress.at(-1)?.error).toBe('The direct connection timed out.');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(progress.at(-1)?.error).toBe('The direct connection timed out.');
    expect(rtc.isSendingImage).toBe(false);
    rtc.stop();
  });

  it('falls back to the generic close when no reason arrives', async () => {
    const { rtc, identity, peer, signals, progress } = await imageManager();
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array([1, 2, 3])], 'one.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId),
    );
    const channel = FakePeerConnection.instances[0]!.channels[0]!;
    channel.readyState = 'closed';
    channel.dispatchEvent(new Event('close'));

    await vi.advanceTimersByTimeAsync(1_499);
    expect(progress.at(-1)?.phase).not.toBe('failed');
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.phase).toBe('failed');
    expect(progress.at(-1)?.error).toBe('The direct connection closed during the transfer.');
    rtc.stop();
  });

  it('ignores a duplicate image accept instead of replacing the connection', async () => {
    const { rtc, identity, peer, signals } = await imageManager();
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array([1, 2, 3])], 'one.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    const accept = await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId);
    await rtc.handleSignal(accept);
    await rtc.handleSignal(accept);

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(signals.filter((entry) => entry.signal === 'offer')).toHaveLength(1);
    expect(rtc.isSendingImage).toBe(true);
    rtc.stop();
  });

  it('tolerates a duplicate answer without failing the transfer', async () => {
    const { rtc, identity, peer, signals, progress } = await imageManager();
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array([1, 2, 3])], 'one.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId),
    );
    const answer = await signalEnvelope(peer, identity.humanId, 'answer', offer!.transferId, {
      sdp: { type: 'answer', sdp: 'v=0' },
    });
    await rtc.handleSignal(answer);
    await rtc.handleSignal(answer);

    expect(rtc.isSendingImage).toBe(true);
    expect(progress.some((entry) => entry.phase === 'failed')).toBe(false);
    rtc.stop();
  });

  it('limits queued bytes to the receiver window when bufferedAmount stays stale', async () => {
    const { rtc, identity, peer, signals } = await imageManager();
    const size = 1024 * 1024;
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array(size)], 'large.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId),
    );
    const channel = FakePeerConnection.instances[0]!.channels[0]!;
    channel.dispatchEvent(new Event('open'));
    await vi.advanceTimersByTimeAsync(0);

    // FakeDataChannel deliberately never increases bufferedAmount, matching
    // older WebKit versions that only report it asynchronously.
    expect(sentBinaryBytes(channel)).toBe(0);
    channel.receive(JSON.stringify({ type: 'window', received: size + 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBinaryBytes(channel)).toBe(0);

    channel.receive(JSON.stringify({ type: 'window', received: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBinaryBytes(channel)).toBe(256 * 1024);

    channel.receive(JSON.stringify({ type: 'window', received: 256 * 1024 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBinaryBytes(channel)).toBe(512 * 1024);
    rtc.stop();
  });

  it('paces the compatibility fallback when the peer does not send windows', async () => {
    const { rtc, identity, peer, signals } = await imageManager();
    const size = 1024 * 1024;
    rtc.sendImage(
      peer.humanId,
      'channel',
      new File([new Uint8Array(size)], 'large.png', { type: 'image/png' }),
    );
    const offer = signals.find((entry) => entry.signal === 'image-offer');
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-accept', offer!.transferId),
    );
    const channel = FakePeerConnection.instances[0]!.channels[0]!;
    channel.dispatchEvent(new Event('open'));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(sentBinaryBytes(channel)).toBe(0);

    await vi.advanceTimersByTimeAsync(101);
    expect(sentBinaryBytes(channel)).toBeGreaterThan(0);
    expect(sentBinaryBytes(channel)).toBeLessThan(128 * 1024);
    rtc.stop();
  });

  it('acknowledges receive windows only when the sender requests flow control', async () => {
    const { rtc, identity, peer, completed } = await imageManager();
    const transferId = 'window-transfer';
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'image-offer', transferId, { sizeMb: 0.125 }),
    );
    await rtc.acceptImage(transferId);
    await rtc.handleSignal(
      await signalEnvelope(peer, identity.humanId, 'offer', transferId, {
        sdp: { type: 'offer', sdp: 'v=0' },
      }),
    );

    const channel = FakePeerConnection.instances[0]!.channels[0]!;
    channel.receive(
      JSON.stringify({ type: 'meta', size: 128 * 1024, mime: 'image/png', flowControl: true }),
    );
    expect(channel.sent).toContain(JSON.stringify({ type: 'window', received: 0 }));

    channel.receive(new Uint8Array(64 * 1024).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.sent).toContain(JSON.stringify({ type: 'window', received: 64 * 1024 }));

    channel.receive(new Uint8Array(64 * 1024).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toEqual([transferId]);
    expect(channel.sent).toContain(JSON.stringify({ type: 'ack' }));
    rtc.stop();
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
