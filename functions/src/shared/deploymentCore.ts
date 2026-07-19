import {
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT,
  isBoxMinterDiscountMintsPerWallet,
} from './boxMinterProtocol.js';

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type DropFamily =
  | 'default'
  | 'little_swag_boxes'
  | 'poncho_drifella'
  | 'drifella_binder'
  | 'drifella_shirt'
  | 'little_swag_hoodies'
  | 'card_nft_2';

export type MetadataPathFormat = 'legacy' | 'compact';

export type DropPaths = {
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

type MintSelectionOption = {
  key: string;
  label: string;
  startId: number;
  endId: number;
};

export type MintSelectionConfig = {
  kind: 'size';
  options: MintSelectionOption[];
};

const IPFS_PROTOCOL = 'ipfs://';
const RAW_CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const BASE32_LOOKUP: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Array.from(BASE32_ALPHABET).map((char, index) => [char, index] as const)),
);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function decodeBase32Lower(value: string): Uint8Array | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const digit = BASE32_LOOKUP[char];
    if (typeof digit !== 'number') return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function readUvarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return { value, nextOffset: index + 1 };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function isRawCidV1(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('b')) return false;
  const bytes = decodeBase32Lower(normalized.slice(1));
  if (!bytes?.length) return false;

  const version = readUvarint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = readUvarint(bytes, version.nextOffset);
  if (!codec) return false;
  const multihashCode = readUvarint(bytes, codec.nextOffset);
  if (!multihashCode) return false;
  const multihashLength = readUvarint(bytes, multihashCode.nextOffset);
  if (!multihashLength || multihashLength.value < 1) return false;
  return bytes.length === multihashLength.nextOffset + multihashLength.value;
}

function isRawIpfsCid(value: string): boolean {
  return RAW_CID_V0_RE.test(value) || isRawCidV1(value);
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function normalizeIpfsProtocolUrl(value: string): string {
  const trimmed = trimTrailingSlashes(String(value || '').trim());
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().startsWith(IPFS_PROTOCOL)) return trimmed;
  const withoutProtocol = trimmed.slice(IPFS_PROTOCOL.length).replace(/^ipfs\//i, '');
  return `${IPFS_PROTOCOL}${withoutProtocol.replace(/^\/+/, '')}`;
}

export function normalizeMetadataPathFormat(
  value: unknown,
  fallback: MetadataPathFormat = 'legacy',
): MetadataPathFormat {
  return value === 'compact' || value === 'legacy' ? value : fallback;
}

export function normalizeMintSelectionConfig(
  raw: MintSelectionConfig | undefined,
): MintSelectionConfig | undefined {
  if (!raw || raw.kind !== 'size' || !Array.isArray(raw.options)) return undefined;
  const options = raw.options.flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || key).trim();
    const startId = Math.floor(Number(entry?.startId));
    const endId = Math.floor(Number(entry?.endId));
    if (!key || !label || !Number.isFinite(startId) || !Number.isFinite(endId) || startId < 1 || endId < startId) {
      return [];
    }
    return [{ key, label, startId, endId }];
  });
  if (options.length !== BOX_MINTER_MINT_VARIANT_OPTION_COUNT) return undefined;
  return {
    kind: 'size',
    options,
  };
}

export function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return isBoxMinterDiscountMintsPerWallet(parsed) ? parsed : 1;
}

export function normalizeDropBase(base: string): string {
  // Accept either `https://...`, `ipfs://...`, or a raw CID like `bafy...`.
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) return '';
  if (isRawIpfsCid(trimmed)) return `${IPFS_PROTOCOL}${trimmed}`;
  return normalizeIpfsProtocolUrl(trimmed);
}

export function dropPathsFromBase(
  dropBase: string,
  metadataPathFormat: MetadataPathFormat = 'compact',
): DropPaths {
  const base = normalizeDropBase(dropBase);
  if (metadataPathFormat === 'legacy') {
    return {
      base,
      collectionJson: `${base}/collection.json`,
      boxesJsonBase: `${base}/json/boxes/`,
      figuresJsonBase: `${base}/json/figures/`,
      receiptsBoxesJsonBase: `${base}/json/receipts/boxes/`,
      receiptsFiguresJsonBase: `${base}/json/receipts/figures/`,
    };
  }
  return {
    base,
    collectionJson: `${base}/collection.json`,
    boxesJsonBase: `${base}/b`,
    figuresJsonBase: `${base}/f`,
    receiptsBoxesJsonBase: `${base}/rb`,
    receiptsFiguresJsonBase: `${base}/rf`,
  };
}

export function normalizeBoxMinterMetadataBaseForComparison(uriBase: string): string {
  // Legacy singleton configs stored `${dropBase}/json/boxes/` rather than the canonical drop base.
  return normalizeDropBase(uriBase).replace(/\/json\/boxes$/i, '');
}

export function canonicalizeDropAssetUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const normalizedIpfs = normalizeIpfsProtocolUrl(trimmed);
  if (normalizedIpfs.toLowerCase().startsWith(IPFS_PROTOCOL)) return normalizedIpfs;
  if (!hasUrlScheme(normalizedIpfs)) return normalizedIpfs;

  try {
    const parsed = new URL(trimmed);
    const hostMatch = parsed.hostname.match(/^([^./]+)\.ipfs\./i);
    if (hostMatch?.[1]) {
      return `${IPFS_PROTOCOL}${hostMatch[1]}${trimTrailingSlashes(parsed.pathname)}${parsed.search}${parsed.hash}`;
    }
    const pathMatch = parsed.pathname.match(/^\/ipfs\/([^/]+)(\/.*)?$/i);
    if (pathMatch?.[1]) {
      return `${IPFS_PROTOCOL}${pathMatch[1]}${trimTrailingSlashes(pathMatch[2] || '')}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Non-URL strings should pass through unchanged.
  }

  return trimmed;
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  card_nft_2: 'card_nft_2',
  drifella_binder: 'drifella_binder',
  drifella_shirt: 'drifella_shirt',
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  poncho_drifella: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return Object.prototype.hasOwnProperty.call(
    DROP_FAMILY_BY_DROP_ID,
    normalizedDropId,
  )
    ? DROP_FAMILY_BY_DROP_ID[normalizedDropId]
    : 'default';
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'drifella_binder' ||
    normalized === 'drifella_shirt' ||
    normalized === 'card_nft_2' ||
    normalized === 'default'
  ) {
    return normalized as DropFamily;
  }
  return defaultDropFamilyForDropId(dropId || '');
}
