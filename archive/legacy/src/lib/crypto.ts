import { WORDLIST } from './words';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const PEER_ID_PREFIX = 'h_';
export const SAS_WORD_COUNT = 8;
export const SAS_BITS = 88;

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function fromUtf8(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Copy a typed array into a plain ArrayBuffer accepted by Web Crypto. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomToken(byteLength = 16): string {
  return bytesToBase64Url(randomBytes(byteLength));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('Invalid base64url value');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toLengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > 0xffffffff) {
    throw new Error('Value too large to length-prefix');
  }
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, bytes.byteLength, false);
  return concatBytes(prefix, bytes);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
}

export async function hashToken(token: string): Promise<string> {
  return bytesToBase64Url(await sha256(utf8(token)));
}

export function normalizeName(input: string): string {
  return input.replace(/\s+/gu, ' ').trim().slice(0, 32);
}

export function displayName(input: string): string {
  const normalized = normalizeName(input);
  return normalized || 'Anonymous human';
}

export interface IdentityMaterial {
  peerId: string;
  publicKey: string;
  privateKey: CryptoKey;
}

export async function derivePeerId(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await sha256(
    concatBytes(utf8('rendezvous/id/v1'), toLengthPrefixed(rawPublicKey)),
  );
  return PEER_ID_PREFIX + bytesToBase64Url(digest).slice(0, 22);
}

export async function generateIdentityMaterial(): Promise<IdentityMaterial> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const peerId = await derivePeerId(raw);
  return {
    peerId,
    publicKey: bytesToBase64Url(raw),
    privateKey: pair.privateKey,
  };
}

export function isRawPublicKey(value: string): boolean {
  try {
    const raw = base64UrlToBytes(value);
    return raw.byteLength === 65 && raw[0] === 0x04;
  } catch {
    return false;
  }
}

export function isPeerId(value: string): boolean {
  return /^h_[A-Za-z0-9_-]{22}$/u.test(value);
}

async function importRawPublicKey(publicKey: string): Promise<CryptoKey> {
  if (!isRawPublicKey(publicKey)) {
    throw new Error('Invalid public key');
  }
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(base64UrlToBytes(publicKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

/** Sign domain-separated bytes. Returns base64url ECDSA P-256 SHA-256 signature. */
export async function signDomain(
  privateKey: CryptoKey,
  domain: string,
  payload: Uint8Array,
): Promise<string> {
  const input = concatBytes(utf8(domain), new Uint8Array([0]), payload);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toArrayBuffer(input),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyDomain(
  publicKey: string,
  domain: string,
  payload: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    const key = await importRawPublicKey(publicKey);
    const input = concatBytes(utf8(domain), new Uint8Array([0]), payload);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(base64UrlToBytes(signature)),
      toArrayBuffer(input),
    );
  } catch {
    return false;
  }
}

export async function signText(
  privateKey: CryptoKey,
  domain: string,
  value: string,
): Promise<string> {
  return signDomain(privateKey, domain, utf8(value));
}

export async function verifyText(
  publicKey: string,
  domain: string,
  value: string,
  signature: string,
): Promise<boolean> {
  return verifyDomain(publicKey, domain, utf8(value), signature);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

/**
 * Derive the stable human-verification words locally.
 * Domain-separated, length-prefixed, sorted raw keys; no network exchange.
 */
export async function deriveVerificationWords(
  firstPublicKey: string,
  secondPublicKey: string,
): Promise<string[]> {
  const keys = [base64UrlToBytes(firstPublicKey), base64UrlToBytes(secondPublicKey)].sort(
    compareBytes,
  );
  const first = keys[0];
  const second = keys[1];
  if (!first || !second) throw new Error('Two public keys are required');

  const digest = await sha256(
    concatBytes(
      utf8('rendezvous/sas/v1'),
      toLengthPrefixed(first),
      toLengthPrefixed(second),
    ),
  );

  const words: string[] = [];
  let bitOffset = 0;
  for (let word = 0; word < SAS_WORD_COUNT; word += 1) {
    let index = 0;
    for (let bit = 0; bit < 11; bit += 1) {
      const byte = digest[Math.floor(bitOffset / 8)] ?? 0;
      const bitInByte = 7 - (bitOffset % 8);
      index = (index << 1) | ((byte >> bitInByte) & 1);
      bitOffset += 1;
    }
    const entry = WORDLIST[index];
    if (!entry) throw new Error('Invalid verification word index');
    words.push(entry);
  }
  return words;
}

export function fingerprintFromSdp(sdp: string | undefined): string | null {
  if (!sdp) return null;
  const match = /^a=fingerprint:(sha-256 [0-9A-Fa-f:]+)\r?$/mu.exec(sdp);
  return match?.[1]?.toLowerCase() ?? null;
}

export function humanHandshakeTranscript(input: {
  transferId: string;
  from: string;
  to: string;
  localFingerprint: string;
  remoteFingerprint: string;
}): string {
  return [
    'rendezvous/handshake/v1',
    `transfer:${input.transferId}`,
    `from:${input.from}`,
    `to:${input.to}`,
    `local:${input.localFingerprint}`,
    `remote:${input.remoteFingerprint}`,
  ].join('\n');
}

export function signalAuthTranscript(nonce: string): string {
  return `rendezvous/signal-auth/v1\nnonce:${nonce}`;
}
