export function isCommerceDocumentSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]+$/.test(value) && !value.includes('/');
}
