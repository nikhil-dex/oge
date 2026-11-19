/**
 * Load additional GitHub Vault pages only when the owner explicitly asks to
 * search beyond the first page. Search stays in the browser; the API already
 * returns owner-scoped committed Notes and supports stable GitHub cursors.
 *
 * Every invocation is bounded to keep large Vaults responsive. The caller
 * retains the last accepted cursor so another click resumes where it stopped.
 */
export async function loadVaultSearchPages({
  cursor, fetchPage, onPage, shouldStop = () => false, maxPages = 12,
} = {}) {
  if (typeof cursor !== 'string' || !cursor ||
      typeof fetchPage !== 'function' || typeof onPage !== 'function' ||
      typeof shouldStop !== 'function' ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 12)
    throw new TypeError('Invalid Vault search parameters');

  const seen = new Set();
  let nextCursor = cursor;
  let pages = 0;
  let loaded = 0;
  while (nextCursor && pages < maxPages) {
    if (shouldStop()) return { nextCursor, pages, loaded, complete: false, stopped: true };
    if (seen.has(nextCursor)) throw new Error('Vault pagination did not advance');
    seen.add(nextCursor);
    const page = await fetchPage(nextCursor);
    if (shouldStop()) return { nextCursor, pages, loaded, complete: false, stopped: true };
    if (!page || !Array.isArray(page.notes) ||
        page.notes.length < 1 || page.notes.length > 25 ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== 'string' || !page.nextCursor ||
            page.nextCursor === nextCursor)) ||
        !Number.isSafeInteger(page.total) || page.total < 0)
      throw new Error('Invalid GitHub Notes page');
    // Don't advance the cursor until the UI has accepted this page.
    await onPage(page.notes, page);
    pages += 1;
    loaded += page.notes.length;
    nextCursor = page.nextCursor;
  }
  return { nextCursor, pages, loaded, complete: nextCursor === null, stopped: false };
}
