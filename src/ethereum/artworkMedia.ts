import { isEthereumMetadataImage } from '../../shared/ethereum/metadataImage';

export function isEthereumMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function hasValidEthereumMedia(value: Record<string, unknown>): boolean {
  const ratio = value.aspectRatio;
  return isEthereumMetadataImage(value.image) &&
    (value.animation_url === undefined || isEthereumMediaUrl(value.animation_url)) &&
    (value.category === undefined || ['egg', 'painting', 'video'].includes(String(value.category))) &&
    (value.revealStatus === undefined || value.revealStatus === 'revealed' || value.revealStatus === 'unrevealed') &&
    (ratio === undefined || ratio !== null && typeof ratio === 'object' && 'width' in ratio && 'height' in ratio &&
      Number.isSafeInteger(ratio.width) && Number(ratio.width) > 0 &&
      Number.isSafeInteger(ratio.height) && Number(ratio.height) > 0);
}
