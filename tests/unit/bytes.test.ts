import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/rdz/bytes';

describe('canonical JSON', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: [3, { b: 1, a: 2 }], a: null })).toBe(
      '{"a":null,"z":[3,{"a":2,"b":1}]}',
    );
  });

  it('keeps a __proto__ key inside the signed form', () => {
    // A plain object would silently drop the key into the prototype setter,
    // letting any relay inject unsigned content into an accepted envelope.
    const value = JSON.parse('{"__proto__":{"injected":true},"kind":"PING"}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"injected":true},"kind":"PING"}');
  });

  it('preserves order-insensitive equality for keys built in any order', () => {
    const left = JSON.parse('{"__proto__":{"a":1},"b":2}');
    const right = JSON.parse('{"b":2,"__proto__":{"a":1}}');
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });
});
