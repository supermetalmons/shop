export const MI_NOTE_2_CONTRACT_ADDRESS = '0x8ffc6bfbce284b508f0e53b8599f8f03ffeb452f';
export const MI_NOTE_3_CONTRACT_ADDRESS = '0xc22bd85e6d6c058226f46a693f0df4054496db5b';
export const MI_NOTE_CONTRACT_ADDRESS = '0x495f947276749ce646f68ac8c248420045cb7b5e';
export const MI_NOTE_MODERN_CONTRACT_ADDRESSES = [MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS] as const;
export const MI_NOTE_CONTRACT_ADDRESSES = [...MI_NOTE_MODERN_CONTRACT_ADDRESSES, MI_NOTE_CONTRACT_ADDRESS] as const;
export const MI_NOTE_CARDS_API_PATH = '/mi-note-cards';
export const MAX_MI_NOTE_TOKEN_IDS = 10_000;
export const MAX_MI_NOTE_STREAM_BYTES = 1024 * 1024;

const MAX_TOKEN_ID = (1n << 256n) - 1n;

export type MiNoteContractAddress = typeof MI_NOTE_CONTRACT_ADDRESSES[number];
export type MiNoteTokenIdsByContract = Record<MiNoteContractAddress, string[]>;
export type MiNoteCardsProvider = 'alchemy' | 'opensea';
export type MiNoteCardsError = 'provider-timeout' | 'provider-unavailable';
export type MiNoteCardsResult =
  | { status: 'success'; provider: MiNoteCardsProvider; visibilityLimited: boolean }
  | { status: 'error'; error: MiNoteCardsError };

export type MiNoteCardsCollectionEvent = {
  type: 'collection';
  contractAddress: MiNoteContractAddress;
  tokenIds: string[];
  provider: MiNoteCardsProvider;
  visibilityLimited: boolean;
};

export type MiNoteCardsErrorEvent = {
  type: 'error';
  contractAddress: MiNoteContractAddress;
  error: MiNoteCardsError;
};

export type MiNoteCardsOutcome = MiNoteCardsCollectionEvent | MiNoteCardsErrorEvent;
export type MiNoteCardsEvent = MiNoteCardsOutcome | { type: 'done' };

export type MiNoteCardsResponse = {
  ok: true;
  tokenIdsByContract: MiNoteTokenIdsByContract;
  resultsByContract: Record<MiNoteContractAddress, MiNoteCardsResult>;
};

export function normalizeMiNoteAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(value)
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

function isCanonicalTokenIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_MI_NOTE_TOKEN_IDS) return false;
  const ids = new Set<string>();
  for (const id of value) {
    if (
      typeof id !== 'string' || id.length > 78 || !/^(0|[1-9][0-9]*)$/.test(id)
    ) return false;
    const parsed = BigInt(id);
    if (parsed > MAX_TOKEN_ID || parsed.toString() !== id || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderMetadata(value: Record<string, unknown>): boolean {
  return (value.provider === 'alchemy' || value.provider === 'opensea') &&
    value.visibilityLimited === (value.provider === 'opensea');
}

function isProviderError(value: unknown): value is MiNoteCardsError {
  return value === 'provider-timeout' || value === 'provider-unavailable';
}

export function isExactMiNoteCardsEvent(value: unknown): value is MiNoteCardsEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'done') return Object.keys(value).length === 1;
  if (!MI_NOTE_CONTRACT_ADDRESSES.some((contract) => contract === value.contractAddress)) return false;
  if (value.type === 'collection') {
    return Object.keys(value).length === 5 && isCanonicalTokenIds(value.tokenIds) && isProviderMetadata(value);
  }
  return value.type === 'error' && Object.keys(value).length === 3 && isProviderError(value.error);
}

export function isExactMiNoteCardsResponse(value: unknown): value is MiNoteCardsResponse {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.ok !== true) return false;
  const groups = value.tokenIdsByContract;
  const results = value.resultsByContract;
  if (!isRecord(groups) || !isRecord(results)) return false;
  if (
    Object.keys(groups).length !== MI_NOTE_CONTRACT_ADDRESSES.length ||
    Object.keys(results).length !== MI_NOTE_CONTRACT_ADDRESSES.length
  ) return false;
  let total = 0;
  let successes = 0;
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    if (!Object.hasOwn(groups, contract) || !Object.hasOwn(results, contract)) return false;
    const tokenIds = groups[contract];
    const result = results[contract];
    if (!isCanonicalTokenIds(tokenIds) || !isRecord(result)) return false;
    if (result.status === 'success') {
      if (Object.keys(result).length !== 3 || !isProviderMetadata(result)) return false;
      successes += 1;
    } else if (
      result.status !== 'error' || Object.keys(result).length !== 2 ||
      !isProviderError(result.error) || tokenIds.length !== 0
    ) return false;
    total += tokenIds.length;
    if (total > MAX_MI_NOTE_TOKEN_IDS) return false;
  }
  return successes > 0;
}
