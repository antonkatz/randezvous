/**
 * Pure calendar helpers. `now` is always a parameter; these functions never
 * read a clock. All boundaries use the circle's IANA timezone via Intl.
 */

const DAY_MS = 86_400_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatterCache.set(timeZone, created);
  return created;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function requireTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }
}

export function calendarDate(timestamp: number, timeZone: string): CalendarDate {
  if (!Number.isFinite(timestamp)) throw new Error('timestamp must be finite');
  requireTimeZone(timeZone);
  const parts = formatter(timeZone).formatToParts(timestamp);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) {
    throw new Error('Could not resolve calendar date');
  }
  return { year, month, day };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function dateKey(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

export function dayKey(timestamp: number, timeZone: string): string {
  return dateKey(calendarDate(timestamp, timeZone));
}

function parseDayKey(key: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(key);
  if (!match) throw new Error(`Invalid day key: ${key}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid day key: ${key}`);
  }
  return { year, month, day };
}

export function isDayKey(value: string): boolean {
  try {
    parseDayKey(value);
    return true;
  } catch {
    return false;
  }
}

/** Calendar days since 1970-01-01 in the circle's timezone. */
export function dayNumber(timestamp: number, timeZone: string): number {
  const date = calendarDate(timestamp, timeZone);
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

export function dayNumberFromKey(key: string): number {
  const date = parseDayKey(key);
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

export function dayKeyFromNumber(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error('day number must be an integer');
  return dateKey({
    year: new Date(value * DAY_MS).getUTCFullYear(),
    month: new Date(value * DAY_MS).getUTCMonth() + 1,
    day: new Date(value * DAY_MS).getUTCDate(),
  });
}

export function addDays(key: string, amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new Error('day amount must be an integer');
  return dayKeyFromNumber(dayNumberFromKey(key) + amount);
}

export function previousDayKey(key: string): string {
  return addDays(key, -1);
}

export function nextDayKey(key: string): string {
  return addDays(key, 1);
}

/** ISO weekday with Monday = 0 … Sunday = 6. */
function weekdayIndex(key: string): number {
  const date = parseDayKey(key);
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

/** Monday of the week containing timestamp, as a YYYY-MM-DD key. */
export function weekKey(timestamp: number, timeZone: string): string {
  return weekKeyFromDayKey(dayKey(timestamp, timeZone));
}

export function weekKeyFromDayKey(key: string): string {
  return addDays(key, -weekdayIndex(key));
}

/** Week index with Monday alignment; useful for deterministic prompt choice. */
export function weekNumber(timestamp: number, timeZone: string): number {
  return Math.floor(dayNumberFromKey(weekKey(timestamp, timeZone)) / 7);
}

export function monthKey(timestamp: number, timeZone: string): string {
  const date = calendarDate(timestamp, timeZone);
  return `${pad(date.year, 4)}-${pad(date.month)}`;
}

export function seasonKey(timestamp: number, timeZone: string): string {
  const date = calendarDate(timestamp, timeZone);
  return `${pad(date.year, 4)}-Q${Math.floor((date.month - 1) / 3) + 1}`;
}

export function quarter(timestamp: number, timeZone: string): 1 | 2 | 3 | 4 {
  const date = calendarDate(timestamp, timeZone);
  return (Math.floor((date.month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

/** Positive modulo used by prompt selection and other deterministic lists. */
export function positiveModulo(value: number, modulo: number): number {
  if (!Number.isSafeInteger(modulo) || modulo < 1) {
    throw new Error('modulo must be a positive integer');
  }
  return ((value % modulo) + modulo) % modulo;
}
