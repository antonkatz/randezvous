import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../src/rdz/crypto';
import { randomRendezvousId } from '../../src/rdz/ids';
import { MeshManager } from '../../src/rdz/mesh';
import { ConnectionBudget } from '../../src/rdz/connection-budget';
import type { MaskRecord } from '../../src/rdz/types';

class FakePeerConnection {
  static instances = 0;
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;

  constructor() {
    FakePeerConnection.instances += 1;
  }

  createDataChannel() {
    return {
      readyState: 'connecting',
      addEventListener: vi.fn(),
      send: vi.fn(),
    };
  }

  addEventListener = vi.fn();

  async createOffer() {
    return { type: 'offer', sdp: 'v=0' };
  }

  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }

  close = vi.fn();
}

describe('verified-only mesh signalling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = 0;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
    });
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup() {
    const identity = await createIdentity();
    const mask: MaskRecord = {
      ...identity,
      id: 'mask-test',
      createdAt: Date.now(),
      verifiedOnlySignalling: false,
    };
    const peerId = randomRendezvousId();
    const verified = new Set<string>();
    let verifiedOnly = false;
    const budget = new ConnectionBudget();
    const mesh = new MeshManager(mask, {
      budget,
      bootstrapUrl: '',
      isVerified: (beingId) => verified.has(beingId),
      verifiedOnlySignalling: () => verifiedOnly,
      isBusy: () => false,
      onEnvelope: vi.fn(),
      onStatus: vi.fn(),
      onPeers: vi.fn(),
      onTraffic: vi.fn(),
    });
    mesh.start();
    return {
      mesh,
      budget,
      peerId,
      verified,
      setVerifiedOnly(value: boolean) {
        verifiedOnly = value;
      },
    };
  }

  it('does not open an unverified direct link while the preference is on', async () => {
    const { mesh, peerId, verified, setVerifiedOnly } = await setup();
    setVerifiedOnly(true);

    mesh.considerPeer(peerId);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakePeerConnection.instances).toBe(0);

    verified.add(peerId);
    mesh.refreshSignallingPolicy();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakePeerConnection.instances).toBe(1);

    mesh.stop();
  });

  it('closes unverified links when enabled and allows them again when disabled', async () => {
    const { mesh, budget, peerId, setVerifiedOnly } = await setup();

    mesh.considerPeer(peerId);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakePeerConnection.instances).toBe(1);
    expect(mesh.liveConnectionCount).toBe(1);

    setVerifiedOnly(true);
    mesh.refreshSignallingPolicy();
    expect(mesh.liveConnectionCount).toBe(0);
    expect(budget.size).toBe(0);

    setVerifiedOnly(false);
    mesh.refreshSignallingPolicy();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakePeerConnection.instances).toBe(2);
    expect(mesh.liveConnectionCount).toBe(1);

    mesh.stop();
  });
});
