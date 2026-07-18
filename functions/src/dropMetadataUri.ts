import { canonicalizeDropAssetUrl, normalizeDropBase } from './config/deployment.js';

export type DropMetadataAssetKind = 'box' | 'dude' | 'certificate';

const LEGACY_BOX_RE = /\/json\/boxes\/(\d+)\.json(?:[?#].*)?$/i;
const LEGACY_FIGURE_RE = /\/json\/figures\/(\d+)\.json(?:[?#].*)?$/i;
const LEGACY_RECEIPT_BOX_RE = /\/json\/receipts\/boxes\/([^/?#]+)\.json(?:[?#].*)?$/i;
const LEGACY_RECEIPT_FIGURE_RE = /\/json\/receipts\/figures\/(\d+)\.json(?:[?#].*)?$/i;
const COMPACT_BOX_RE = /\/b(\d+)\.json(?:[?#].*)?$/i;
const COMPACT_FIGURE_RE = /\/f(\d+)\.json(?:[?#].*)?$/i;
const COMPACT_RECEIPT_BOX_RE = /\/rb([^/?#]+)\.json(?:[?#].*)?$/i;
const COMPACT_RECEIPT_FIGURE_RE = /\/rf(\d+)\.json(?:[?#].*)?$/i;
const BOX_URI_PATTERNS: readonly RegExp[] = [LEGACY_BOX_RE, COMPACT_BOX_RE];
const FIGURE_URI_PATTERNS: readonly RegExp[] = [LEGACY_FIGURE_RE, COMPACT_FIGURE_RE];
const RECEIPT_URI_PATTERNS: readonly RegExp[] = [
  LEGACY_RECEIPT_BOX_RE,
  LEGACY_RECEIPT_FIGURE_RE,
  COMPACT_RECEIPT_BOX_RE,
  COMPACT_RECEIPT_FIGURE_RE,
];
const BOX_ID_URI_PATTERNS: readonly RegExp[] = [LEGACY_BOX_RE, COMPACT_BOX_RE, LEGACY_RECEIPT_BOX_RE, COMPACT_RECEIPT_BOX_RE];
const FIGURE_ID_URI_PATTERNS: readonly RegExp[] = [
  LEGACY_FIGURE_RE,
  LEGACY_RECEIPT_FIGURE_RE,
  COMPACT_FIGURE_RE,
  COMPACT_RECEIPT_FIGURE_RE,
];
const METADATA_BASE_SUFFIX_PATTERNS: readonly RegExp[] = [
  /\/collection\.json(?:[?#].*)?$/i,
  ...BOX_ID_URI_PATTERNS,
  ...FIGURE_ID_URI_PATTERNS,
];

function matchesAnyPattern(uri: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(uri));
}

function firstCapturedGroup(uri: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(uri);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function canonicalMetadataUri(uri: string): string {
  return canonicalizeDropAssetUrl(uri);
}

export function canonicalMetadataBase(baseRaw: string): string {
  return canonicalMetadataUri(normalizeDropBase(baseRaw));
}

export function metadataKindFromUri(uriRaw: string): DropMetadataAssetKind | null {
  const uri = canonicalMetadataUri(uriRaw);
  if (!uri) return null;
  if (matchesAnyPattern(uri, BOX_URI_PATTERNS)) return 'box';
  if (matchesAnyPattern(uri, FIGURE_URI_PATTERNS)) return 'dude';
  if (matchesAnyPattern(uri, RECEIPT_URI_PATTERNS)) return 'certificate';
  return null;
}

export function boxIdFromMetadataUri(uriRaw: string): string | undefined {
  const uri = canonicalMetadataUri(uriRaw);
  return firstCapturedGroup(uri, BOX_ID_URI_PATTERNS);
}

export function dudeIdFromMetadataUri(uriRaw: string): number | undefined {
  const uri = canonicalMetadataUri(uriRaw);
  const value = Number(firstCapturedGroup(uri, FIGURE_ID_URI_PATTERNS));
  return Number.isFinite(value) ? value : undefined;
}

export function metadataBaseFromMetadataUri(uriRaw: string): string | null {
  const uri = canonicalMetadataUri(uriRaw);
  if (!uri) return null;

  const normalized = METADATA_BASE_SUFFIX_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, ''),
    normalizeDropBase(uri),
  );

  return normalized && normalized !== uri ? normalized : null;
}

export function selectMetadataUri(...candidates: unknown[]): string {
  for (const candidateRaw of candidates) {
    if (typeof candidateRaw !== 'string' || !candidateRaw) continue;
    const candidate = canonicalMetadataUri(candidateRaw);
    if (candidate) return candidate;
  }
  return '';
}
