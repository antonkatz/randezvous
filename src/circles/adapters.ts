import {
  base64UrlToBytes,
  bytesToBase64Url,
  isRawPublicKey,
  sha256,
  signDomain,
  verifyDomain,
} from '../lib/crypto';
import type { StoredHuman, StoredIdentity } from '../lib/types';
import type { Friends, Identity, PublicKeyId } from './types';

export const CIRCLE_RECORD_SIGNATURE_DOMAIN = 'randevouz/circle-record/v1';

/** Peer-id → pinned raw public key map used by the browser adapter. */
export class CircleKeyDirectory {
  private readonly keys = new Map<PublicKeyId, string>();

  constructor(initial: Iterable<{ id: PublicKeyId; publicKey: string }> = []) {
    for (const entry of initial) this.add(entry.id, entry.publicKey);
  }

  add(id: PublicKeyId, publicKey: string): void {
    this.keys.set(id, publicKey);
  }

  resolve(id: PublicKeyId): string | null {
    return this.keys.get(id) ?? null;
  }

  entries(): Map<PublicKeyId, string> {
    return new Map(this.keys);
  }
}

export type PublicKeyResolver = (publicKeyId: PublicKeyId) => string | null;

/**
 * Adapt the app's existing P-256 identity to the injected circle Identity
 * interface. Verification needs the pinned/invited public key for each peer;
 * populate the directory from direct humans and circle members as records
 * arrive.
 */
export function createBrowserCircleIdentity(
  identity: StoredIdentity,
  directory: CircleKeyDirectory | PublicKeyResolver,
): Identity {
  const resolve: PublicKeyResolver =
    typeof directory === 'function' ? directory : (id) => directory.resolve(id);
  if (typeof directory !== 'function') {
    directory.add(identity.id, identity.publicKey);
  }

  return {
    selfKey: identity.id,
    async sign(bytes) {
      return signDomain(identity.privateKey, CIRCLE_RECORD_SIGNATURE_DOMAIN, bytes);
    },
    async verify(publicKeyId, bytes, signature) {
      const publicKey = resolve(publicKeyId);
      if (!publicKey) return false;
      return verifyDomain(
        publicKey,
        CIRCLE_RECORD_SIGNATURE_DOMAIN,
        bytes,
        signature,
      );
    },
    async hash(bytes) {
      return bytesToBase64Url(await sha256(bytes));
    },
  };
}

/** The app's persistent direct humans become the circle Friends source. */
export function friendsFromHumans(
  humans: Iterable<Pick<StoredHuman, 'id'>>,
): Friends {
  const direct = new Set<PublicKeyId>();
  for (const human of humans) direct.add(human.id);
  return {
    directFriends() {
      return new Set(direct);
    },
  };
}

/** Register a pinned human's public key with a directory. */
export function addHumanKey(
  directory: CircleKeyDirectory,
  human: Pick<StoredHuman, 'id' | 'publicKey'>,
): void {
  directory.add(human.id, human.publicKey);
}

/** Convenience for validating a raw base64url public key before registering. */
export function isUsablePublicKey(publicKey: string): boolean {
  try {
    return base64UrlToBytes(publicKey).byteLength === 65;
  } catch {
    return false;
  }
}
