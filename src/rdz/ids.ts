import { asBufferSource, base64UrlToBytes, bytesToBase64Url } from './bytes';
import { EMOJI_ALPHABET, emojiForByte } from './emoji';
import { WORDLIST } from './words';
import type { HumanId, RendezvousId } from './types';

export const ID_BYTES = 11;
export const WORD_COUNT = 8;
export const EMOJI_COUNT = 11;
export const DEFAULT_SHORT_WORDS = 4;
export const DEFAULT_SHORT_EMOJI = 6;

export async function humanIdFromPublicKey(publicKeyBase64Url: string): Promise<HumanId> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(base64UrlToBytes(publicKeyBase64Url)));
  return bytesToBase64Url(new Uint8Array(digest).slice(0, ID_BYTES));
}

export function randomRendezvousId(): RendezvousId {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

export function randomTransferId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

export function idToWords(id: string): string[] {
  const bytes = base64UrlToBytes(id);
  if (bytes.length !== ID_BYTES) throw new Error('Identifier must be 88 bits.');
  const words: string[] = [];
  let bitOffset = 0;
  for (let wordIndex = 0; wordIndex < WORD_COUNT; wordIndex += 1) {
    let value = 0;
    for (let bit = 0; bit < 11; bit += 1) {
      const absolute = bitOffset + bit;
      const byte = bytes[absolute >> 3] ?? 0;
      const bitValue = (byte >> (7 - (absolute & 7))) & 1;
      value = (value << 1) | bitValue;
    }
    const word = WORDLIST[value];
    if (!word) throw new Error(`Word list is incomplete at ${value}`);
    words.push(word);
    bitOffset += 11;
  }
  return words;
}

export function wordsToId(words: readonly string[]): string | null {
  if (words.length !== WORD_COUNT) return null;
  const bytes = new Uint8Array(ID_BYTES);
  let bitOffset = 0;
  for (const word of words) {
    const index = WORDLIST.indexOf(word as (typeof WORDLIST)[number]);
    if (index < 0) return null;
    for (let bit = 0; bit < 11; bit += 1) {
      const value = (index >> (10 - bit)) & 1;
      if (value) {
        const absolute = bitOffset + bit;
        bytes[absolute >> 3] = (bytes[absolute >> 3] ?? 0) | (1 << (7 - (absolute & 7)));
      }
    }
    bitOffset += 11;
  }
  return bytesToBase64Url(bytes);
}

export function idToEmoji(id: string): string[] {
  const bytes = base64UrlToBytes(id);
  if (bytes.length !== ID_BYTES) throw new Error('Identifier must be 88 bits.');
  return [...bytes].map((byte) => emojiForByte(byte));
}

export function emojiToId(emoji: readonly string[]): string | null {
  if (emoji.length !== EMOJI_COUNT) return null;
  const bytes = new Uint8Array(ID_BYTES);
  for (let index = 0; index < EMOJI_COUNT; index += 1) {
    const symbol = emoji[index];
    if (!symbol) return null;
    const value = EMOJI_ALPHABET_INDEX.get(symbol);
    if (value === undefined) return null;
    bytes[index] = value;
  }
  return bytesToBase64Url(bytes);
}

const EMOJI_ALPHABET_INDEX = new Map(EMOJI_ALPHABET.map((symbol, index) => [symbol, index]));

export function shortWords(words: readonly string[], length = DEFAULT_SHORT_WORDS): string[] {
  return words.slice(0, Math.max(1, Math.min(words.length, length)));
}

export function shortEmoji(emoji: readonly string[], length = DEFAULT_SHORT_EMOJI): string[] {
  return emoji.slice(0, Math.max(1, Math.min(emoji.length, length)));
}

export function formatWords(words: readonly string[]): string {
  return words.join(' ');
}

export function formatEmoji(emoji: readonly string[]): string {
  return emoji.join('');
}

/** Returns a display prefix long enough to be unique among the given identifiers. */
export function uniqueWordDisplay(
  ids: readonly string[],
  self: string,
  minimum = DEFAULT_SHORT_WORDS,
): string[] {
  const others = ids.filter((id) => id !== self).map((id) => idToWords(id));
  const own = idToWords(self);
  let length = Math.min(own.length, Math.max(minimum, 1));
  while (length < own.length) {
    const prefix = own.slice(0, length).join('\u0000');
    const collision = others.some((words) => words.slice(0, length).join('\u0000') === prefix);
    if (!collision) break;
    length += 1;
  }
  return own.slice(0, length);
}

export function uniqueEmojiDisplay(
  ids: readonly string[],
  self: string,
  minimum = DEFAULT_SHORT_EMOJI,
): string[] {
  const others = ids.filter((id) => id !== self).map((id) => idToEmoji(id));
  const own = idToEmoji(self);
  let length = Math.min(own.length, Math.max(minimum, 1));
  while (length < own.length) {
    const prefix = own.slice(0, length).join('');
    const collision = others.some((emoji) => emoji.slice(0, length).join('') === prefix);
    if (!collision) break;
    length += 1;
  }
  return own.slice(0, length);
}
