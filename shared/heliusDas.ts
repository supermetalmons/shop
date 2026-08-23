export function heliusSearchAssetsItems<T = any>(result: any): T[] {
  return Array.isArray(result?.items) ? result.items : [];
}

export const HELIUS_SEARCH_ASSETS_MAX_CURSOR_BYTES = 4096;
export const HELIUS_SEARCH_ASSETS_PAGE_LIMITS = [250, 125, 64] as const;
export const HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES = 128;
export const HELIUS_SEARCH_ASSETS_MAX_PROVIDER_CALLS = 384;
export const HELIUS_SEARCH_ASSETS_MAX_CANDIDATES = 6000;
export const HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type HeliusSearchAssetsCursorPageInfo =
  | { hasMore: false }
  | { hasMore: true; cursor: string };

export function heliusSearchAssetsCursorPageInfo(
  result: unknown,
  pageItemCount: number,
  requestedLimit: number,
  seenCursors: ReadonlySet<string> = new Set(),
): HeliusSearchAssetsCursorPageInfo {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid-helius-pagination');
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.items) || record.items.length !== pageItemCount) {
    throw new Error('invalid-helius-pagination');
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('invalid-helius-pagination');
  }
  if (!Number.isSafeInteger(pageItemCount) || pageItemCount < 0 || pageItemCount > requestedLimit) {
    throw new Error('invalid-helius-pagination');
  }
  if (record.limit !== undefined) {
    if (
      !Number.isSafeInteger(record.limit) ||
      Number(record.limit) <= 0 ||
      Number(record.limit) > requestedLimit ||
      pageItemCount > Number(record.limit)
    ) throw new Error('invalid-helius-pagination');
  }
  for (const field of ['total', 'grand_total', 'last_indexed_slot'] as const) {
    const value = record[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      throw new Error('invalid-helius-pagination');
    }
  }
  const cursor = record.cursor;
  if (cursor !== undefined && (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > HELIUS_SEARCH_ASSETS_MAX_CURSOR_BYTES ||
    new TextEncoder().encode(cursor).byteLength > HELIUS_SEARCH_ASSETS_MAX_CURSOR_BYTES ||
    seenCursors.has(cursor)
  )) throw new Error('invalid-helius-pagination');
  if (pageItemCount === 0) return { hasMore: false };
  if (typeof cursor !== 'string') throw new Error('invalid-helius-pagination');
  return { hasMore: true, cursor };
}

type HeliusSearchAssetsTotalPolicy = 'respect' | 'ignore';

export type HeliusSearchAssetsPaginationOptions = {
  totalPolicy?: HeliusSearchAssetsTotalPolicy;
};

export function heliusSearchAssetsHasNextPage(
  result: any,
  page: number,
  items: ReadonlyArray<unknown>,
  fallbackLimit: number,
  options: HeliusSearchAssetsPaginationOptions = {},
): boolean {
  if (!items.length) return false;
  const responseLimit = Number(result?.limit);
  const limit =
    Number.isFinite(responseLimit) && responseLimit > 0
      ? responseLimit
      : fallbackLimit;
  if (items.length < limit) return false;
  if (options.totalPolicy === 'ignore') return true;

  const total = Number(result?.total);
  const resultPage = Number(result?.page ?? page);
  if (Number.isFinite(total) && total >= 0 && Number.isFinite(resultPage)) {
    return resultPage * limit < total;
  }
  return true;
}
