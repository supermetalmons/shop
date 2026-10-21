export function formatAddressLocality(
  city?: string,
  region?: string,
  postalCode?: string,
): string {
  const locality = city?.trim() ?? '';
  const state = region?.trim() ?? '';
  const postal = postalCode?.trim().replace(/\s+/g, ' ') ?? '';
  if (!locality && !state && !postal) return '';
  return [locality, state, postal].join(', ').trimEnd();
}

export function formatAddressForDisplay(full: string): string {
  const lines = full.split(/\r\n?|\n/);
  const addressLineIndexes = lines.flatMap((line, index) => line.trim() ? [index] : []);
  if (addressLineIndexes.length < 4) return full;

  const localityIndex = addressLineIndexes[addressLineIndexes.length - 2];
  const parts = lines[localityIndex].split(',').map((part) => part.trim());
  if (parts.every(Boolean)) return full;

  lines[localityIndex] = parts.filter(Boolean).join(', ');
  return lines.join('\n');
}
