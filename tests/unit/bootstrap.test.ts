import { describe, expect, it } from 'vitest';
import { bootstrapUrlFrom } from '../../src/rdz/mesh';

describe('bootstrap seed URL', () => {
  it('uses the same origin for LAN, tunnel, and production hosts', () => {
    expect(bootstrapUrlFrom('http:', '192.168.2.50:5173', '')).toBe(
      'ws://192.168.2.50:5173/signal',
    );
    expect(bootstrapUrlFrom('https:', 'phone-test.trycloudflare.com', '')).toBe(
      'wss://phone-test.trycloudflare.com/signal',
    );
    expect(bootstrapUrlFrom('https:', 'randezvous.instanthero.ca', '')).toBe(
      'wss://randezvous.instanthero.ca/signal',
    );
  });

  it('allows disabling the seed or overriding it explicitly', () => {
    expect(bootstrapUrlFrom('https:', 'example.test', '?seed=off')).toBe('');
    expect(bootstrapUrlFrom('https:', 'example.test', '?seed=wss%3A%2F%2Fseed.test%2Fsignal')).toBe(
      'wss://seed.test/signal',
    );
  });

  it('prefers the configured seed URL', () => {
    expect(bootstrapUrlFrom('https:', 'example.test', '', 'wss://configured.test/signal')).toBe(
      'wss://configured.test/signal',
    );
  });
});
