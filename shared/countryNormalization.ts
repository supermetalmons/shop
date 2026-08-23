export function normalizeCountryCode(country?: string): string {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s._-]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA' || compact === 'USA' || compact === 'US') {
    return 'US';
  }
  return '';
}
