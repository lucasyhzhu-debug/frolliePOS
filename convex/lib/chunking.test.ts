import { describe, it, expect } from "vitest";
import { chunkItems } from "./chunking";

const HEADER = "<b>Header</b>";

describe("chunkItems", () => {
  it("returns the header-only chunk when items is empty", () => {
    const out = chunkItems(HEADER, []);
    expect(out).toEqual([HEADER]);
  });

  it("returns a single chunk when total is under the budget", () => {
    const out = chunkItems(HEADER, ["item-1", "item-2", "item-3"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Header");
    expect(out[0]).toContain("item-1");
    expect(out[0]).toContain("item-3");
  });

  it("splits into multiple chunks when total exceeds the budget", () => {
    const heavy = Array.from({ length: 30 }, (_, i) => "x".repeat(200) + i);
    const out = chunkItems(HEADER, heavy, { maxChunkLen: 1000 });
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(1000);
  });

  it("truncates a single item that exceeds maxItemLen (per-item guard, C1 fix)", () => {
    const out = chunkItems(HEADER, ["x".repeat(5000)], { maxChunkLen: 4000, maxItemLen: 3800 });
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(out.join("\n")).toContain("…[truncated");
  });

  it("emits a continuation header on chunks 2+ using the provided builder", () => {
    const heavy = Array.from({ length: 30 }, () => "x".repeat(200));
    const out = chunkItems(HEADER, heavy, {
      maxChunkLen: 1000,
      continuationHeader: (i) => `<i>…continued (${i + 1})</i>`,
    });
    expect(out[0]).toContain("Header");
    expect(out[1]).toContain("continued");
  });

  it("never splits a single item across two chunks", () => {
    // Use items large enough relative to maxChunkLen to FORCE multi-chunk output.
    // Without the precondition check below, a too-generous budget would make
    // this test pass trivially on the single-chunk path (~4 items × 53 chars +
    // header + separators fits in 250 → forces splits; ~30 items × ~14 chars
    // would NOT). The precondition assertion is load-bearing.
    const items = Array.from({ length: 30 }, (_, i) => `<b>ITEM-${i}</b>${"x".repeat(40)}`);
    const out = chunkItems(HEADER, items, { maxChunkLen: 250 });
    expect(out.length).toBeGreaterThan(1);
    const joined = out.join("\n");
    for (let i = 0; i < 30; i++) {
      const marker = `<b>ITEM-${i}</b>`;
      const count = joined.split(marker).length - 1;
      expect(count).toBe(1);
    }
  });
});
