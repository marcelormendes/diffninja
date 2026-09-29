import { visibleControls } from "./hidden-characters.js";

/**
 * Escape untrusted text for HTML element and attribute contexts. Bidirectional
 * and other invisible control characters are shown as visible markers, so a page
 * never lets untrusted text reorder or hide what a reviewer reads.
 */
export function escapeHtml(text: string): string {
  return visibleControls(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
