// convex/lib/chunking.ts

export interface ChunkerOptions {
  /** Safety margin under Telegram's 4096-char hard limit. Default 4000. */
  maxChunkLen?: number;
  /** Per-item cap — items longer than this are truncated to prevent single-item overflow (C1 fix). Default 3800. */
  maxItemLen?: number;
  /** Marker appended to a truncated item. Default `"\n  …[truncated — check source]"`. */
  truncateMarker?: string;
  /**
   * Builds the header line for chunks 2..N. Default omits a continuation header.
   *
   * PRECONDITION: when set, the effective per-item budget shrinks by
   * `contHeader.length + 2`. The chunk-length invariant only holds if
   * `maxItemLen + contHeader.length + 2 <= maxChunkLen`. With defaults
   * (maxChunkLen=4000, maxItemLen=3800), continuation headers up to ~200 chars
   * are safe. A header much longer than that combined with a worst-case
   * truncated item can produce a chunk above `maxChunkLen`.
   */
  continuationHeader?: (chunkIndex: number) => string;
}

/**
 * Chunk a list of pre-rendered items into Telegram-safe message strings.
 *
 * Invariants:
 *  - Every chunk.length <= maxChunkLen (default 4000, safely under Telegram's 4096).
 *  - Single items longer than maxItemLen are truncated (C1 fix — without this guard,
 *    a single pathologically-long item plus a continuation header could exceed
 *    4096 and Telegram returns 400).
 *  - Items are never split across chunks — preserves rendered structure.
 *  - The first chunk always begins with `header`. Chunks 2..N begin with
 *    `continuationHeader(chunkIndex)` if provided.
 */
export function chunkItems(
  header: string,
  items: string[],
  opts: ChunkerOptions = {},
): string[] {
  const maxChunkLen = opts.maxChunkLen ?? 4000;
  const maxItemLen = opts.maxItemLen ?? 3800;
  const truncateMarker = opts.truncateMarker ?? "\n  …[truncated — check source]";
  const continuationHeader = opts.continuationHeader;

  if (items.length === 0) return [header];

  const chunks: string[] = [];
  let current = header;
  for (const raw of items) {
    let item = raw;
    if (item.length > maxItemLen) {
      item = item.slice(0, maxItemLen - truncateMarker.length) + truncateMarker;
    }
    const addition = `\n\n${item}`;
    if (current.length + addition.length > maxChunkLen) {
      chunks.push(current);
      const contHeader = continuationHeader ? continuationHeader(chunks.length) : "";
      current = contHeader ? `${contHeader}\n\n${item}` : item;
    } else {
      current += addition;
    }
  }
  chunks.push(current);
  return chunks;
}
