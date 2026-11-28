import { describe, expect, it } from 'vitest';
import { ANNOUNCEMENT_GRACE_MS } from '../../src/rdz/crypto';
import { idToEmoji, idToWords, randomRendezvousId } from '../../src/rdz/ids';
import {
  activeAnnouncements,
  audioRemaining,
  buildChannels,
  dedupeAnnouncements,
  filterChannels,
  filterHumans,
  goingCount,
  groupAnnouncementsByMinute,
  isOnline,
  nextAnnouncementTimes,
  parseTimeInput,
  sortAnnouncements,
  sortHumans,
} from '../../src/rdz/state';
import type { GoingAnnouncement, Human } from '../../src/rdz/types';

function human(verified = false, lastSeen = Date.now()): Human {
  const id = randomRendezvousId();
  return {
    id,
    publicKey: `pk-${id}`,
    words: idToWords(id),
    emoji: idToEmoji(id),
    lastSeen,
    verified,
  };
}

function announcement(
  author: Human,
  channelId: string,
  scheduledAt: number,
  createdAt = Date.now(),
): GoingAnnouncement {
  return {
    envelopeId: `env-${Math.random()}`,
    author: author.id,
    publicKey: author.publicKey,
    channelId,
    scheduledAt,
    createdAt,
  };
}

describe('presence and ordering', () => {
  it('expires presence after five minutes', () => {
    const now = Date.now();
    expect(isOnline(human(false, now - 60_000), now)).toBe(true);
    expect(isOnline(human(false, now - 6 * 60_000), now)).toBe(false);
  });

  it('sorts verified humans first, then online', () => {
    const now = Date.now();
    const verified = human(true, now);
    const online = human(false, now);
    const offline = human(false, now - 10 * 60_000);
    expect(sortHumans([offline, online, verified], now).map((entry) => entry.id)).toEqual([
      verified.id,
      online.id,
      offline.id,
    ]);
  });

  it('sorts announcements by time, then verified', () => {
    const now = Date.now();
    const verified = human(true, now);
    const unverified = human(false, now);
    const early = announcement(verified, 'channel', now);
    const late = announcement(unverified, 'channel', now + 60_000);
    expect(sortAnnouncements([late, early], new Map([
      [verified.id, verified],
      [unverified.id, unverified],
    ]))).toEqual([early, late]);
  });
});

describe('channels and expiry', () => {
  const now = Date.now();

  it('removes an announcement three minutes after its scheduled time', () => {
    const author = human(true, now);
    const entry = announcement(author, 'channel', now);
    expect(activeAnnouncements([entry], now)).toHaveLength(1);
    expect(activeAnnouncements([entry], now + ANNOUNCEMENT_GRACE_MS)).toHaveLength(1);
    expect(activeAnnouncements([entry], now + ANNOUNCEMENT_GRACE_MS + 1)).toHaveLength(0);
  });

  it('keeps a pinned channel with no live announcements', () => {
    const channels = buildChannels([], [{ channelId: 'pinned', label: 'Sunday', createdAt: now }], now);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.pinnedLabel).toBe('Sunday');
  });

  it('deduplicates the same human, channel, and minute', () => {
    const author = human(true, now);
    const first = announcement(author, 'channel', now, now - 10);
    const second = announcement(author, 'channel', now, now);
    expect(dedupeAnnouncements([first, second])).toEqual([second]);
  });

  it('counts each human once even with multiple announced times', () => {
    const author = human(true, now);
    const other = human(false, now);
    expect(
      goingCount([
        announcement(author, 'channel', now),
        announcement(author, 'channel', now + 60_000),
        announcement(other, 'channel', now),
      ]),
    ).toBe(2);
  });

  it('lists the next two distinct upcoming times in order', () => {
    const author = human(true, now);
    const base = Math.floor(now / 60_000) * 60_000;
    const entries = [
      announcement(author, 'channel', base + 120_000),
      announcement(author, 'channel', base),
      announcement(author, 'channel', base),
      announcement(author, 'channel', base + 60_000),
    ];
    expect(nextAnnouncementTimes(entries)).toEqual([base, base + 60_000]);
    expect(nextAnnouncementTimes(entries, 3)).toEqual([base, base + 60_000, base + 120_000]);
  });

  it('groups announcements by local minute', () => {
    const author = human(true, now);
    const minute = Math.floor(now / 60_000) * 60_000 + 5_000;
    const first = announcement(author, 'channel', minute);
    const second = announcement(author, 'channel', minute + 30_000);
    const groups = groupAnnouncementsByMinute([first, second]);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(2);
  });
});

describe('search and time input', () => {
  it('filters humans by words and emoji', () => {
    const entry = human(false);
    expect(filterHumans([entry], entry.words[0] ?? '')).toHaveLength(1);
    expect(filterHumans([entry], entry.emoji[0] ?? '')).toHaveLength(1);
    expect(filterHumans([entry], 'zzzz-not-here')).toHaveLength(0);
  });

  it('filters channels by pinned label', () => {
    const channels = buildChannels([], [{ channelId: randomRendezvousId(), label: 'Full moon', createdAt: Date.now() }]);
    expect(filterChannels(channels, 'moon')).toHaveLength(1);
  });

  it('counts a one-minute audio window down to zero', () => {
    expect(audioRemaining(null)).toBe(60_000);
    expect(audioRemaining(0, 30_000)).toBe(30_000);
    expect(audioRemaining(0, 60_000)).toBe(0);
    expect(audioRemaining(0, 90_000)).toBe(0);
  });

  it('parses a minute-precision time', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const parsed = parseTimeInput('13:07', now.getTime());
    expect(parsed).not.toBeNull();
    expect(new Date(parsed ?? 0).getMinutes()).toBe(7);
  });

  it('rejects malformed times', () => {
    expect(parseTimeInput('24:00')).toBeNull();
    expect(parseTimeInput('12:60')).toBeNull();
    expect(parseTimeInput('noon')).toBeNull();
  });
});
