export function isEthereumMetadataImage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^data:image\/svg\+xml(?:;base64)?,/.test(value)) return true;
  if (!/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}
