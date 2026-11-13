import type { SolanaCluster } from './newDropConfig.ts';

export const MONS_SHOP_RECEIPTS_POOL_ID = 'mons_shop_receipts';

export type ReceiptPoolSpec = {
  receiptPoolId: string;
  displayName: string;
  authority: string;
  collectionMetadataUri: string;
  collectionName: string;
  collectionSymbol: string;
  collectionDescription: string;
  collectionExternalUrl: string;
  collectionImage: string;
  royaltiesBasisPoints: number;
  royaltiesRecipient: string;
  receiptsTree: {
    maxDepth: number;
    maxBufferSize: number;
    canopyDepth: number;
  };
};

const MONS_SHOP_RECEIPTS_SPEC: ReceiptPoolSpec = {
  receiptPoolId: MONS_SHOP_RECEIPTS_POOL_ID,
  displayName: 'mons shop receipts',
  authority: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  collectionMetadataUri:
    'https://cdn.lil.org/nft/mons_shop_receipts/collection.json',
  collectionName: 'mons shop receipts',
  collectionSymbol: 'receipts',
  collectionDescription: 'redeemed on mons dot shop',
  collectionExternalUrl: 'https://mons.shop',
  collectionImage:
    'https://cdn.lil.org/nft/mons_shop_receipts/cover.png',
  royaltiesBasisPoints: 500,
  royaltiesRecipient: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
  receiptsTree: {
    maxDepth: 14,
    maxBufferSize: 64,
    canopyDepth: 8,
  },
};

const RECEIPT_POOL_SPECS: Readonly<
  Record<string, ReceiptPoolSpec>
> = Object.freeze({
  [MONS_SHOP_RECEIPTS_POOL_ID]: MONS_SHOP_RECEIPTS_SPEC,
});

function normalizeReceiptPoolId(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function requireReceiptPoolSpec(
  receiptPoolId: string,
): ReceiptPoolSpec {
  const normalized = normalizeReceiptPoolId(receiptPoolId);
  const spec = RECEIPT_POOL_SPECS[normalized];
  if (!spec) {
    throw new Error(
      `Unknown receipt pool ${receiptPoolId}. Known pools: ${Object.keys(
        RECEIPT_POOL_SPECS,
      ).join(', ')}`,
    );
  }
  return spec;
}

export function receiptPoolJournalPathSegment(args: {
  solanaCluster: SolanaCluster;
  receiptPoolId: string;
}): string {
  const spec = requireReceiptPoolSpec(args.receiptPoolId);
  return `${args.solanaCluster}-${spec.receiptPoolId}`;
}

export type ReceiptPoolSolanaCluster = Extract<
  SolanaCluster,
  'devnet' | 'mainnet-beta'
>;

export const RECEIPT_POOL_CLUSTER_GENESIS_HASHES: Readonly<
  Record<ReceiptPoolSolanaCluster, string>
> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export function assertReceiptPoolRpcGenesisHash(args: {
  solanaCluster: ReceiptPoolSolanaCluster;
  genesisHash: string;
}): void {
  const expected = RECEIPT_POOL_CLUSTER_GENESIS_HASHES[args.solanaCluster];
  if (args.genesisHash !== expected) {
    throw new Error(
      `Receipt pool RPC genesis hash mismatch for ${args.solanaCluster}: expected ${expected}, got ${args.genesisHash}`,
    );
  }
}
