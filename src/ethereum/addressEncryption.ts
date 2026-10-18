export function ethereumAddressEncryptionKey(fallback: string, chainId: number, development: boolean, localPublicKey: unknown): string {
  return development && chainId === 31337 && typeof localPublicKey === 'string' && localPublicKey.trim()
    ? localPublicKey.trim() : fallback;
}
