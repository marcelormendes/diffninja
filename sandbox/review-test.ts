// Sandbox for testing diffninja's review submission. Not shipped.
export function clampPage(page: number, pages: number): number {
  if (page > pages) return pages;
  if (page < 1) return 1;
  return page;
}
