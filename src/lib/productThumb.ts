/** Deterministic chip text/color for products without a photo (v1.2 #3).
 *  Stored `initials`/`hue` (already captured in /mgr/products) win; otherwise
 *  derive from the product name + code so a chip never changes between renders. */

export function deriveInitials(name: string, storedInitials?: string): string {
  const stored = storedInitials?.trim();
  if (stored) return stored.slice(0, 3).toUpperCase();
  const trimmed = name.trim();
  const first = trimmed[0] ?? "?";
  const digits = trimmed.match(/\d+/)?.[0] ?? "";
  return (first + digits).slice(0, 2).toUpperCase();
}

export function resolveHue(code: string, storedHue?: number): number {
  if (typeof storedHue === "number" && storedHue >= 0 && storedHue <= 360) {
    // Already validated to [0, 360]; don't `% 360` here or a stored 360 would
    // collapse to 0. hsl(360 …) is valid and renders identically to hsl(0 …).
    return Math.round(storedHue);
  }
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}

/** Phthalo-dark-safe chip colors. Dynamic hue → inline hsl (the one sanctioned
 *  raw-color exception; a Tailwind token can't carry a runtime hue). */
export function chipColors(hue: number): { bg: string; fg: string; border: string } {
  return {
    bg: `hsl(${hue} 38% 26%)`,
    fg: `hsl(${hue} 30% 82%)`,
    border: `hsl(${hue} 40% 42% / 0.6)`,
  };
}
