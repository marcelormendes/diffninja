// Sandbox for testing diffninja's review submission. Not shipped.
export function clampPage(page: number, pages: number): number {
  if (pages < 1) return 1;
  if (page > pages) return pages;
  if (page < 1) return 1;
  return Math.floor(page);
}

export function pageCount(total: number, size: number): number {
  if (size <= 0) throw new Error("size must be positive");
  return Math.ceil(total / size);
}
