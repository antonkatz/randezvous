/**
 * Small locally synthesised cues for voice. Nothing is recorded and no sound
 * data leaves the browser; each cue is a handful of short oscillator notes.
 *
 * `voice-start` rises, `voice-end` falls, and `request` is a distinct
 * three-note call so an incoming request cannot be mistaken for a live
 * conversation starting or ending.
 */
export type ChimeKind = 'voice-start' | 'voice-end' | 'request';

interface Tone {
  frequency: number;
  offset: number;
  duration: number;
  gain: number;
}

const CUES: Record<ChimeKind, readonly Tone[]> = {
  'voice-start': [
    { frequency: 659.25, offset: 0, duration: 0.09, gain: 0.16 },
    { frequency: 987.77, offset: 0.1, duration: 0.18, gain: 0.14 },
  ],
  'voice-end': [
    { frequency: 987.77, offset: 0, duration: 0.09, gain: 0.16 },
    { frequency: 659.25, offset: 0.1, duration: 0.18, gain: 0.14 },
  ],
  request: [
    { frequency: 523.25, offset: 0, duration: 0.11, gain: 0.14 },
    { frequency: 783.99, offset: 0.13, duration: 0.11, gain: 0.13 },
    { frequency: 1046.5, offset: 0.26, duration: 0.2, gain: 0.12 },
  ],
};

export class Chime {
  private context: AudioContext | null = null;

  play(kind: ChimeKind): void {
    try {
      const context = this.contextFor();
      if (!context) return;
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const now = context.currentTime;
      for (const tone of CUES[kind]) this.ring(context, tone, now);
    } catch {
      // Browsers can refuse to start audio before a user gesture. A cue that
      // cannot play must never interrupt the voice flow.
    }
  }

  private contextFor(): AudioContext | null {
    if (this.context) return this.context;
    if (!window.AudioContext) return null;
    this.context = new window.AudioContext();
    return this.context;
  }

  private ring(context: AudioContext, tone: Tone, now: number): void {
    const start = now + tone.offset;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(tone.frequency, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(tone.gain, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + tone.duration + 0.02);
  }
}
