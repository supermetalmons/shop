export const MI_NOTE_2_CONTRACT_ADDRESS = '0x8ffc6bfbce284b508f0e53b8599f8f03ffeb452f';
export const MI_NOTE_CARDS_API_PATH = '/mi-note-cards';

const MAX_TOKEN_ID = (1n << 256n) - 1n;

export type MiNoteCardsResponse = {
  ok: true;
  tokenIds: string[];
};

export function normalizeMiNoteAddress(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

export function miNoteAddressFromSearch(search: string): { present: boolean; address: string | null } {
  const addresses = new URLSearchParams(search).getAll('address');
  return {
    present: addresses.length > 0,
    address: addresses.length === 1 ? normalizeMiNoteAddress(addresses[0]) : null,
  };
}

export function isExactMiNoteCardsResponse(value: unknown): value is MiNoteCardsResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).length !== 2 || response.ok !== true ||
    !Array.isArray(response.tokenIds) || response.tokenIds.length > 10_000
  ) return false;
  const ids = new Set<string>();
  for (const id of response.tokenIds) {
    if (
      typeof id !== 'string' || id.length > 78 || !/^(0|[1-9][0-9]*)$/.test(id) ||
      BigInt(id) > MAX_TOKEN_ID || ids.has(id)
    ) return false;
    ids.add(id);
  }
  return true;
}
