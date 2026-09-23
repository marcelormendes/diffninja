/**
 * The diffninja mark: a ninja's head in its hood, eyes showing through the
 * slit, a red bandana tied at the back with its tails flying. Inline SVG, so
 * both pages carry it under their no-external-resources policies.
 */
export const BRAND_MARK = [
  '<svg class="brand-mark" viewBox="0 0 64 64" width="26" height="26" aria-hidden="true" focusable="false">',
  '<path class="nj-tail" d="M49 19c5-1 9-4 13-9-1 6-4 10-9 13z"/>',
  '<path class="nj-tail" d="M50 24c5 1 8 4 10 10-4-3-7-4-12-5z"/>',
  '<circle class="nj-hood" cx="28" cy="34" r="24"/>',
  '<path class="nj-band" d="M5 25c15-5 30-5 46 0l-1 7c-14-5-29-5-44 0z"/>',
  '<circle class="nj-band" cx="50" cy="24" r="4"/>',
  '<rect class="nj-skin" x="10" y="34" width="36" height="11" rx="5"/>',
  '<ellipse class="nj-eye" cx="21" cy="39" rx="3" ry="3"/>',
  '<ellipse class="nj-eye" cx="35" cy="39" rx="3" ry="3"/>',
  "</svg>",
].join("");

/** Colors for {@link BRAND_MARK}; the hood stays dark, outlined so it reads on a dark page too. */
export const BRAND_MARK_STYLES = `
.brand-mark { width: 26px; height: 26px; flex: 0 0 auto; }
.brand-mark .nj-hood { fill: #1f2328; stroke: var(--line-strong); stroke-width: 2; }
.brand-mark .nj-band, .brand-mark .nj-tail { fill: #d1242f; }
.brand-mark .nj-skin { fill: #f2c9a0; }
.brand-mark .nj-eye { fill: #1f2328; }
`;
