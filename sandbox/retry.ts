// Sandbox: a small retry helper for review submission tests. Not shipped.
export async function retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
