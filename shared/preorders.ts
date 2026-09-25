import type { SolanaCluster } from './deploymentCore.js';

export const PREORDER_CARD_COUNT = 1395;
export const PREORDER_RESERVATION_TTL_MS = 120_000;
export const PREORDER_PAYMENT_RECIPIENTS = [
  'BmV4TRHUfMZcaa6iZA4tSGf6ACGoLLsYEHcC55AEKAYf',
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
] as const;

export type PreorderConfig = Readonly<{
  preorderId: string;
  cluster: SolanaCluster;
  collection: string;
  authority: string;
  enabled: boolean;
  unitPriceLamports: number;
  metadataBase: string;
  imageBase: string;
  maxItems: number;
}>;

const defaults = {
  authority: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  unitPriceLamports: 250_000_000,
  metadataBase: 'https://cdn.lil.org/nft/mi_note_cards/preorder/json/',
  imageBase: 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/',
  maxItems: 3,
} as const;

export const PREORDER_CONFIGS: readonly PreorderConfig[] = [
  {
    ...defaults,
    preorderId: 'mi_note_cards_devnet',
    cluster: 'devnet',
    collection: '65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv',
    enabled: true,
  },
  {
    ...defaults,
    preorderId: 'mi_note_cards',
    cluster: 'mainnet-beta',
    collection: 'BtEknBg1b9ZLJHLTGJcadxeQhQwtdVsoPGDrc9cXwczG',
    enabled: false,
  },
];

export function getPreorderConfig(id: string): PreorderConfig | undefined {
  return PREORDER_CONFIGS.find((config) => config.preorderId === id);
}

export function isPreorderCardId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= PREORDER_CARD_COUNT;
}

export function preorderMetadataUri(config: PreorderConfig, id: number): string {
  if (!isPreorderCardId(id)) throw new Error('Invalid preorder card ID.');
  return `${config.metadataBase}${id}.json`;
}

export function preorderImageUrl(config: PreorderConfig, id: number): string {
  if (!isPreorderCardId(id)) throw new Error('Invalid preorder card ID.');
  return `${config.imageBase}${id}.webp`;
}

export function preorderIdFromMetadataUri(config: PreorderConfig, uri: string): number | null {
  if (!uri.startsWith(config.metadataBase)) return null;
  const suffix = uri.slice(config.metadataBase.length);
  if (!/^[1-9]\d*\.json$/.test(suffix)) return null;
  const id = Number(suffix.slice(0, -5));
  return isPreorderCardId(id) ? id : null;
}

export type PreorderAsset = { id: number; address: string };
export type PreorderOrderStatus = 'prepared' | 'submitted' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export type PreorderOrder = {
  orderId: string;
  preorderId: string;
  buyer: string;
  cardIds: number[];
  assets: PreorderAsset[];
  status: PreorderOrderStatus;
  expiresAtMs: number;
  signature: string | null;
};
export type PreorderAvailabilityResponse = {
  preorderId: string;
  items: { id: number; status: 'available' | 'reserved' | 'preordered' }[];
};
export type PreorderPrepareRequest = { preorderId: string; buyer: string; cardIds: number[]; requestId: string };
export type PreorderPrepareResponse = { order: PreorderOrder; transactionBase64: string | null };
export type PreorderSubmitRequest = { preorderId: string; orderId: string; transactionBase64: string };
export type PreorderCancelRequest = { preorderId: string; orderId: string };
export type PreorderStatusResponse = { order: PreorderOrder | null };
