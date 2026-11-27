/**
 * Mesh control frames are transport mechanics, not application messages.
 * They never carry PING, GOING, or SIGNAL content.
 */
export function meshHelloBody(nonce: string): string {
  return `rdz-mesh-hello:${nonce}`;
}

/**
 * A cheap synchronous key used only to collapse concurrent copies of the same
 * signed envelope before the canonical hash resolves. The durable dedup key
 * remains the hash of the canonical signed bytes.
 */
export function envelopeTransportKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {
    type?: unknown;
    author?: unknown;
    createdAt?: unknown;
    signature?: unknown;
  };
  if (
    typeof record.type !== 'string' ||
    typeof record.author !== 'string' ||
    typeof record.createdAt !== 'number' ||
    typeof record.signature !== 'string'
  ) {
    return null;
  }
  return `${record.type}:${record.author}:${record.createdAt}:${record.signature}`;
}
