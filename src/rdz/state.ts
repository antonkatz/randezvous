import { ANNOUNCEMENT_GRACE_MS, PRESENCE_MS } from './crypto';
import { formatEmoji, formatWords, idToEmoji, idToWords, isCanonicalId } from './ids';
import type {
  ChannelView,
  GoingAnnouncement,
  Being,
  PinRecord,
} from './types';

export function isOnline(being: Being, now = Date.now()): boolean {
  return being.lastSeen + PRESENCE_MS > now;
}

export function activeAnnouncements(
  announcements: readonly GoingAnnouncement[],
  now = Date.now(),
): GoingAnnouncement[] {
  return announcements.filter((entry) => entry.scheduledAt + ANNOUNCEMENT_GRACE_MS >= now);
}

export function beingLabel(being: Pick<Being, 'id'>, full = false): string {
  const words = idToWords(being.id);
  return full ? formatWords(words) : formatWords(words.slice(0, 4));
}

export function beingEmojiLabel(being: Pick<Being, 'id'>, full = false): string {
  const emoji = idToEmoji(being.id);
  return formatEmoji(full ? emoji : emoji.slice(0, 6));
}

export function sortBeings(beings: readonly Being[], now = Date.now()): Being[] {
  return [...beings].sort((left, right) => {
    const leftOnline = isOnline(left, now) ? 0 : 1;
    const rightOnline = isOnline(right, now) ? 0 : 1;
    if (left.verified !== right.verified) return left.verified ? -1 : 1;
    if (leftOnline !== rightOnline) return leftOnline - rightOnline;
    return beingLabel(left).localeCompare(beingLabel(right));
  });
}

export function sortAnnouncements(
  announcements: readonly GoingAnnouncement[],
  beings: ReadonlyMap<string, Being>,
): GoingAnnouncement[] {
  return [...announcements].sort((left, right) => {
    if (left.scheduledAt !== right.scheduledAt) return left.scheduledAt - right.scheduledAt;
    const leftBeing = beings.get(left.author);
    const rightBeing = beings.get(right.author);
    if (leftBeing?.verified !== rightBeing?.verified) return leftBeing?.verified ? -1 : 1;
    return beingLabel({ id: left.author }).localeCompare(beingLabel({ id: right.author }));
  });
}

export function dedupeAnnouncements(
  announcements: readonly GoingAnnouncement[],
): GoingAnnouncement[] {
  const byKey = new Map<string, GoingAnnouncement>();
  for (const entry of announcements) {
    const minute = Math.floor(entry.scheduledAt / 60_000);
    const key = `${entry.author}|${entry.channelId}|${minute}`;
    const existing = byKey.get(key);
    if (!existing || entry.createdAt > existing.createdAt) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

export function goingCount(announcements: readonly GoingAnnouncement[]): number {
  return new Set(announcements.map((entry) => entry.author)).size;
}

export function groupAnnouncementsByMinute(
  announcements: readonly GoingAnnouncement[],
): Map<number, GoingAnnouncement[]> {
  const groups = new Map<number, GoingAnnouncement[]>();
  for (const announcement of announcements) {
    const minute = Math.floor(announcement.scheduledAt / 60_000) * 60_000;
    const group = groups.get(minute);
    if (group) group.push(announcement);
    else groups.set(minute, [announcement]);
  }
  return groups;
}

export function nextAnnouncementTimes(
  announcements: readonly GoingAnnouncement[],
  limit = 2,
): number[] {
  return [...groupAnnouncementsByMinute(announcements).keys()]
    .sort((left, right) => left - right)
    .slice(0, limit);
}

export function buildChannels(
  announcements: readonly GoingAnnouncement[],
  pins: readonly PinRecord[],
  now = Date.now(),
): ChannelView[] {
  const active = activeAnnouncements(announcements, now);
  const byId = new Map<string, GoingAnnouncement[]>();
  for (const announcement of active) {
    const entries = byId.get(announcement.channelId);
    if (entries) entries.push(announcement);
    else byId.set(announcement.channelId, [announcement]);
  }
  const pinned = new Map(pins.map((pin) => [pin.channelId, pin]));
  const channels: ChannelView[] = [];
  for (const [id, entries] of byId) {
    channels.push({
      id,
      announcements: entries,
      nextAt: Math.min(...entries.map((entry) => entry.scheduledAt)),
      pinnedLabel: pinned.get(id)?.label ?? null,
    });
  }
  for (const pin of pins) {
    if (byId.has(pin.channelId)) continue;
    channels.push({
      id: pin.channelId,
      announcements: [],
      nextAt: 0,
      pinnedLabel: pin.label,
    });
  }
  return channels.sort((left, right) => {
    if (left.nextAt && right.nextAt) return left.nextAt - right.nextAt;
    if (left.nextAt) return -1;
    if (right.nextAt) return 1;
    return (left.pinnedLabel ?? left.id).localeCompare(right.pinnedLabel ?? right.id);
  });
}

export function filterBeings(beings: readonly Being[], query: string): Being[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...beings];
  return beings.filter((being) => {
    const words = formatWords(idToWords(being.id)).toLowerCase();
    const emoji = formatEmoji(idToEmoji(being.id));
    return words.includes(normalized) || emoji.includes(query.trim());
  });
}

export function filterChannels(channels: readonly ChannelView[], query: string): ChannelView[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...channels];
  return channels.filter((channel) => {
    // A poisoned channel ID must not break filtering; it simply cannot match.
    const words = isCanonicalId(channel.id) ? formatWords(idToWords(channel.id)).toLowerCase() : '';
    const emoji = isCanonicalId(channel.id) ? formatEmoji(idToEmoji(channel.id)) : '';
    const label = channel.pinnedLabel?.toLowerCase() ?? '';
    return words.includes(normalized) || emoji.includes(query.trim()) || label.includes(normalized);
  });
}

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp);
}

export function formatDay(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(timestamp);
}

export function nextOccurrence(hour: number, minute: number, now = Date.now()): number {
  const date = new Date(now);
  date.setSeconds(0, 0);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function parseTimeInput(value: string, now = Date.now()): number | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return nextOccurrence(hour, minute, now);
}

export function isVerified(
  beingId: string,
  verifications: ReadonlyMap<string, { verifiedAt: number | null }>,
): boolean {
  return Boolean(verifications.get(beingId)?.verifiedAt);
}

export const AUDIO_LIMIT_MS = 60_000;

export function audioRemaining(startedAt: number | null, now = Date.now()): number {
  if (startedAt === null) return AUDIO_LIMIT_MS;
  return Math.max(0, AUDIO_LIMIT_MS - (now - startedAt));
}

export function beingDisplay(being: Being): string {
  return `${beingEmojiLabel(being)} ${beingLabel(being)}`;
}
