import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chime } from '../../src/rdz/chime';

interface FakeContext {
  state: 'running' | 'suspended';
  currentTime: number;
  destination: object;
  resume: () => Promise<void>;
  createOscillator: () => {
    type: string;
    frequency: { setValueAtTime: (value: number, at: number) => void };
    connect: (node: object) => object;
    start: (at: number) => void;
    stop: (at: number) => void;
  };
  createGain: () => {
    gain: {
      setValueAtTime: (value: number, at: number) => void;
      exponentialRampToValueAtTime: (value: number, at: number) => void;
    };
    connect: (node: object) => object;
  };
}

function installFakeAudio(): { starts: number[]; stops: number[]; contexts: FakeContext[] } {
  const starts: number[] = [];
  const stops: number[] = [];
  const contexts: FakeContext[] = [];
  const context: FakeContext = {
    state: 'running',
    currentTime: 10,
    destination: {},
    resume: async () => undefined,
    createOscillator: () => {
      const node = {
        type: 'sine',
        frequency: { setValueAtTime: (_value: number, _at: number) => undefined },
        connect: (next: object) => next,
        start: (at: number) => starts.push(at),
        stop: (at: number) => stops.push(at),
      };
      return node;
    },
    createGain: () => ({
      gain: {
        setValueAtTime: (_value: number, _at: number) => undefined,
        exponentialRampToValueAtTime: (_value: number, _at: number) => undefined,
      },
      connect: (next: object) => next,
    }),
  };
  contexts.push(context);
  class FakeAudioContext {
    state = context.state;
    currentTime = context.currentTime;
    destination = context.destination;
    resume = context.resume;
    createOscillator = context.createOscillator;
    createGain = context.createGain;
  }
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  return { starts, stops, contexts };
}

describe('chime cues', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays two notes for voice start and end, three for a request', () => {
    const { starts } = installFakeAudio();
    const chime = new Chime();
    chime.play('voice-start');
    expect(starts).toHaveLength(2);
    chime.play('voice-end');
    expect(starts).toHaveLength(4);
    chime.play('request');
    expect(starts).toHaveLength(7);
  });

  it('reuses one audio context instead of creating one per cue', () => {
    const { contexts } = installFakeAudio();
    const chime = new Chime();
    chime.play('voice-start');
    chime.play('voice-end');
    chime.play('request');
    expect(contexts).toHaveLength(1);
  });

  it('stays silent when the browser has no audio context', () => {
    vi.stubGlobal('window', {});
    const chime = new Chime();
    expect(() => chime.play('request')).not.toThrow();
  });
});
