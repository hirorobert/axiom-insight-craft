/**
 * The ingestion identity of one evidence file the person selected (20261005100000).
 *
 * One key is created when a file is selected, and every request for that selection — a retry after an error or a lost
 * response, the re-call after the column mapping is chosen — sends the same key, so the server replays it instead of
 * recording the rows again. Selecting a file again, even the very same bytes, is a new upload action and gets a new key:
 * the server never assumes that identical content is a retry. The same key with different bytes or a different column
 * mapping is refused (409).
 */
export function newIngestionKey(): string {
  return globalThis.crypto.randomUUID();
}
