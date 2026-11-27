import { describe, expect, it } from 'vitest';
import { wallPhotoWidth } from '../src/lib/ui/wall';

describe('photo wall power law', () => {
  it('gives rank 1 the largest print and decreases with rank', () => {
    const widths = Array.from({ length: 12 }, (_, index) => wallPhotoWidth(index + 1, 1200));
    expect(widths[0]).toBeGreaterThan(widths[1]!);
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index]!).toBeLessThanOrEqual(widths[index - 1]!);
    }
  });

  it('keeps a practical floor for long histories', () => {
    const last = wallPhotoWidth(500, 1200);
    expect(last).toBeGreaterThanOrEqual(112);
    expect(last).toBeLessThan(wallPhotoWidth(1, 1200));
  });

  it('adapts the leading print to a narrow wall', () => {
    const mobile = wallPhotoWidth(1, 340);
    expect(mobile).toBeGreaterThan(200);
    expect(mobile).toBeLessThanOrEqual(340);
    expect(wallPhotoWidth(1, 1200)).toBeGreaterThan(mobile);
    expect(wallPhotoWidth(1, 0)).toBe(112);
  });
});
