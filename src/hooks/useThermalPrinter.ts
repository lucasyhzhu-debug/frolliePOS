/** Split a byte stream into ≤ size chunks for BLE writeWithoutResponse. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return out;
}
