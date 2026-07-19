export function heliusSearchAssetsItems<T = any>(result: any): T[] {
  return Array.isArray(result?.items) ? result.items : [];
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
