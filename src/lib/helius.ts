const DEFAULT_HELIUS_API_KEY = 'b59d8426-e980-4028-bfeb-0d9c7c54582b';

export function getHeliusApiKey(): string {
  return (import.meta.env?.VITE_HELIUS_API_KEY || '').trim() || DEFAULT_HELIUS_API_KEY;
}
