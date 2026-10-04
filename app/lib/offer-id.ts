/** A random u64 offer id, so two offers made in the same millisecond never collide. */
export function randomOfferId(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}
