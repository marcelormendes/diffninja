/**
 * diffninja's color tokens: indigo, the dyed cloth of the mark, for the page
 * and its surfaces; red and green only where they carry meaning (removed and
 * added lines, attention). The pull request page and the call-flow drawer share
 * them, so the drawer reads as part of the page it sits beside.
 */
export const PALETTE_STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f5f6fa;
  --panel: #ffffff;
  --panel-head: #f0f2f8;
  --sunken: #f0f2f8;
  --hover: #eceff7;
  --ink: #1b2033;
  --ink-soft: #545c78;
  --ink-faint: #858ca6;
  --line: #d6dae8;
  --line-soft: #e6e9f2;
  --line-strong: #a9b0c8;
  --accent: #3b55d9;
  --accent-soft: #e6eafd;
  --route: #c3cae4;
  --btn-bg: #ffffff;
  --btn-hover: #f0f2f8;
  --primary: #3b55d9;
  --primary-hover: #3049c4;
  --primary-ink: #ffffff;
  --ok: #1f7a3e;
  --ok-soft: #dcf5e4;
  --warn: #945f00;
  --warn-soft: #fcf1d6;
  --warn-bg: #fcf1d6;
  --alarm: #c42032;
  --alarm-bg: #fde8ea;
  --neutral-soft: #eceff7;
  --teal: #3b55d9;
  --cursor: #3b55d9;
  --add-bg: #e3f7e8;
  --del-bg: #fdebed;
  --add-ink: #1f7a3e;
  --del-ink: #c42032;
  --add-gutter: #cdf0d6;
  --del-gutter: #fad7db;
  --gap-bg: #eef1fb;
  --syn-keyword: #b8325b;
  --syn-string: #1d4f91;
  --syn-comment: #7a819b;
  --syn-number: #2250c8;
  --syn-type: #8a4b08;
  --syn-func: #6d3fc0;
  --shadow: 0 1px 2px rgba(27, 32, 51, 0.06);
  --radius: 8px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121829;
    --panel: #182036;
    --panel-head: #1d2640;
    --sunken: #141b2e;
    --hover: #1f2944;
    --ink: #e7eaf3;
    --ink-soft: #a3abc5;
    --ink-faint: #737c99;
    --line: #2a3553;
    --line-soft: #222c46;
    --line-strong: #4a5678;
    --accent: #8fa6ff;
    --accent-soft: rgba(143, 166, 255, 0.14);
    --route: #33406a;
    --btn-bg: #1d2640;
    --btn-hover: #243050;
    --primary: #6f8cff;
    --primary-hover: #819bff;
    --primary-ink: #0f1424;
    --ok: #5fcf85;
    --ok-soft: rgba(95, 207, 133, 0.14);
    --warn: #e6b450;
    --warn-soft: rgba(230, 180, 80, 0.14);
    --warn-bg: rgba(230, 180, 80, 0.14);
    --alarm: #ff7b86;
    --alarm-bg: rgba(255, 123, 134, 0.13);
    --neutral-soft: rgba(143, 156, 196, 0.14);
    --teal: #8fa6ff;
    --cursor: #8fa6ff;
    --add-bg: rgba(95, 207, 133, 0.11);
    --del-bg: rgba(255, 123, 134, 0.1);
    --add-ink: #5fcf85;
    --del-ink: #ff7b86;
    --add-gutter: rgba(95, 207, 133, 0.2);
    --del-gutter: rgba(255, 123, 134, 0.2);
    --gap-bg: rgba(143, 166, 255, 0.08);
    --syn-keyword: #ff8fb1;
    --syn-string: #a9d4ff;
    --syn-comment: #7f89a8;
    --syn-number: #9ab8ff;
    --syn-type: #ffc27a;
    --syn-func: #cdb3ff;
    --shadow: none;
  }
}
`;
