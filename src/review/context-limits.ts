/**
 * Serialized-state limits shared by the adaptive context plan and the Jev
 * adapter.
 *
 * The limit lives in its own module so the plan and the adapter agree on one
 * number without importing each other at runtime: `context-plan.ts` takes the
 * cap from here, and `jev.ts` re-exports it for the adapter's own callers.
 */

/**
 * Largest serialized state we will send, measured as `JSON.stringify(state).length`
 * so escaping counts. This conservative character cap is not a tokenizer or a
 * guarantee about the API's token limits.
 *
 * The budget is spent essentials first: `file`, `hunk`, `diff`, and `contextNote`
 * are never trimmed. Optional call-flow entries are then admitted whole, highest
 * retention priority first, and an entry that does not fit is dropped whole rather
 * than truncated. Optional context alone therefore never sends a hunk to manual
 * review: only a state whose essentials cannot fit at any trim is oversized, and
 * even that state is returned intact.
 */
export const MAX_STATE_CHARS = 24_000;
