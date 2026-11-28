import { describe, expect, it } from 'vitest';
import { base64UrlToBytes } from '../../src/rdz/bytes';
import { EMOJI_ALPHABET } from '../../src/rdz/emoji';
import {
  EMOJI_COUNT,
  ID_BYTES,
  WORD_COUNT,
  emojiToId,
  idToEmoji,
  idToWords,
  isCanonicalId,
  randomRendezvousId,
  wordsToId,
} from '../../src/rdz/ids';
import { WORDLIST } from '../../src/rdz/words';
import { uniqueEmojiDisplay, uniqueWordDisplay } from '../../src/rdz/ids';

describe('identifier encoding', () => {
  it('has the fixed 2048-word and 256-emoji alphabets', () => {
    expect(WORDLIST).toHaveLength(2048);
    expect(EMOJI_ALPHABET).toHaveLength(256);
    expect(new Set(EMOJI_ALPHABET).size).toBe(256);
  });

  it('round-trips an 88-bit identifier through words', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = randomRendezvousId();
      const words = idToWords(id);
      expect(words).toHaveLength(WORD_COUNT);
      expect(wordsToId(words)).toBe(id);
    }
  });

  it('round-trips an 88-bit identifier through emoji', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = randomRendezvousId();
      const emoji = idToEmoji(id);
      expect(emoji).toHaveLength(EMOJI_COUNT);
      expect(emojiToId(emoji)).toBe(id);
    }
  });

  it('always produces 11-byte canonical identifiers', () => {
    expect(base64UrlToBytes(randomRendezvousId())).toHaveLength(ID_BYTES);
  });

  it('extends word and emoji displays when prefixes collide', () => {
    const self = randomRendezvousId();
    const words = idToWords(self);
    const otherWords = [
      ...words.slice(0, 4),
      ...WORDLIST.filter((word) => !words.includes(word)).slice(0, 4),
    ];
    const other = wordsToId(otherWords);
    expect(other).not.toBeNull();
    if (other) {
      expect(uniqueWordDisplay([self, other], self, 4)).toHaveLength(5);
    }
    const emoji = idToEmoji(self);
    const otherEmoji = [
      ...emoji.slice(0, 6),
      ...EMOJI_ALPHABET.filter((symbol) => !emoji.includes(symbol)).slice(0, 5),
    ];
    const otherEmojiId = emojiToId(otherEmoji);
    expect(otherEmojiId).not.toBeNull();
    if (otherEmojiId) {
      expect(uniqueEmojiDisplay([self, otherEmojiId], self, 6)).toHaveLength(7);
    }
  });

  it('extends landing emoji prefixes from a three-emoji minimum to at most eleven', () => {
    const self = randomRendezvousId();
    const emoji = idToEmoji(self);
    const fourEmoji = [
      ...emoji.slice(0, 3),
      ...EMOJI_ALPHABET.filter((symbol) => !emoji.includes(symbol)).slice(0, 8),
    ];
    const fourEmojiId = emojiToId(fourEmoji);
    expect(fourEmojiId).not.toBeNull();
    if (fourEmojiId) {
      expect(uniqueEmojiDisplay([self, fourEmojiId], self, 3)).toHaveLength(4);
    }

    const elevenEmoji = [
      ...emoji.slice(0, 10),
      ...EMOJI_ALPHABET.filter((symbol) => symbol !== emoji[10]).slice(0, 1),
    ];
    const elevenEmojiId = emojiToId(elevenEmoji);
    expect(elevenEmojiId).not.toBeNull();
    if (elevenEmojiId) {
      expect(uniqueEmojiDisplay([self, elevenEmojiId], self, 3)).toHaveLength(11);
    }
  });

  it('rejects malformed word and emoji sequences', () => {
    expect(wordsToId(['abandon'])).toBeNull();
    expect(emojiToId(['😀'])).toBeNull();
  });

  it('accepts only the canonical 15-character encoding of an 88-bit id', () => {
    expect(isCanonicalId(randomRendezvousId())).toBe(true);
    expect(isCanonicalId('not-a-valid-id')).toBe(false);
    expect(isCanonicalId('')).toBe(false);
    // 11 chars decode to 8 bytes, 16 chars to 12 bytes, 15 chars with padding
    // is non-canonical even though it decodes to 11 bytes.
    expect(isCanonicalId('AAAAAAAAAAA')).toBe(false);
    expect(isCanonicalId('AAAAAAAAAAAAAAAA')).toBe(false);
    expect(isCanonicalId('AAAAAAAAAAAAAA=')).toBe(false);
    expect(isCanonicalId('../AAAAAAAAAAA')).toBe(false);
  });

  it('never throws when a display ID is malformed', () => {
    const self = randomRendezvousId();
    expect(uniqueWordDisplay([self, 'not-a-valid-id'], 'not-a-valid-id')).toEqual(['not-a-valid-id']);
    expect(uniqueEmojiDisplay([self, 'not-a-valid-id'], 'not-a-valid-id')).toEqual(['not-a-valid-id']);
    // A malformed neighbor is skipped rather than poisoning the length search.
    expect(uniqueWordDisplay([self, 'not-a-valid-id'], self, 4)).toHaveLength(4);
  });
});
