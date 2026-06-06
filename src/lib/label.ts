/**
 * Build the aria-label string for a catalog "Add" card.
 *
 * The format is `Add <name> <pack_label>` when pack_label is non-empty,
 * else `Add <name>` only. Whitespace-only pack_label is treated as empty
 * (defensive — the schema allows `v.string()` not `v.optional(v.string())`,
 * so manager-edited products can theoretically land empty here even though
 * seed products always have it).
 *
 * The disambiguation matters: pre-v0.5.9, three Dubai products (1 pc / 3 pcs
 * / 8 pcs) all rendered an "Add Dubai" button — Playwright `/Dubai 1pc/i`
 * never matched any of them. See docs/postmortems/2026-06-issue-44-misdiagnosis.md.
 */
export function buildAddCardLabel(name: string, packLabel: string): string {
  const pack = packLabel.trim();
  return pack ? `Add ${name} ${pack}` : `Add ${name}`;
}
