/**
 * Below a theme's breakpoint, a store control shows its icon and keeps its
 * label for screen readers only. Written out in full because Tailwind compiles
 * only the class names it finds in the source: `max-${bp}:sr-only` would ship
 * nothing.
 *
 * Why at all: a phone header holding the store name plus "Rechercher" and
 * "Panier" in full cut the name of the first deployed shop (certification,
 * étape 9).
 */
export type CompactBelow = 'sm' | 'md' | 'lg';

export const COMPACT: Record<CompactBelow, { label: string; icon: string }> = {
  sm: { label: 'max-sm:sr-only', icon: 'max-sm:inline-flex' },
  md: { label: 'max-md:sr-only', icon: 'max-md:inline-flex' },
  lg: { label: 'max-lg:sr-only', icon: 'max-lg:inline-flex' },
};
