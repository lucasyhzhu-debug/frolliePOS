// Shared Framer Motion variants for the grid-stagger mount animation used by the
// hub (home) and product grid (sale). Factories of `reduce` (from
// `useReducedMotion`) so callers resolve them ONCE per render and reuse the
// single object across children — never call inside a `.map`.
//
// Both fully no-op under prefers-reduced-motion: stagger drops to 0 and items
// start fully visible (opacity 1, no offset) so nothing animates on mount.
// charge-success intentionally does NOT use these — its checkmark-draw is a
// different animation shape and stays local.

export const gridContainerVariants = (reduce: boolean) => ({
  hidden: {},
  show: { transition: { staggerChildren: reduce ? 0 : 0.03 } },
});

export const gridItemVariants = (reduce: boolean) => ({
  hidden: { opacity: reduce ? 1 : 0, y: reduce ? 0 : 8 },
  show: { opacity: 1, y: 0 },
});

export const stepSlideVariants = (dir: 1 | -1, reduce: boolean) => ({
  enter: { opacity: reduce ? 1 : 0, x: reduce ? 0 : dir * 20 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: reduce ? 1 : 0, x: reduce ? 0 : dir * -20 },
});
