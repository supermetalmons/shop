/**
 * Canonical, committed deployment registry.
 *
 * This is the only source of deployment rows. Frontend and Cloud Functions
 * configs project their public shapes from this secret-free superset.
 *
 * Secrets must never be added here.
 */

import type {
  DropFamily,
  MetadataPathFormat,
  MintSelectionConfig,
  SolanaCluster,
} from './deploymentCore.js';
import type { SharedMediaMapConfig } from './mediaMap.js';

export type DeploymentMediaMapConfig = SharedMediaMapConfig;

export type DeploymentRegistryDrop = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;

  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  secondaryMarketHref?: string;
  figureMedia?: DeploymentMediaMapConfig;
  boxMedia?: DeploymentMediaMapConfig;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfig;

  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;

  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

export type DeploymentRegistryDropFieldSpecs = {
  readonly [Field in keyof DeploymentRegistryDrop]-?: {
    readonly required: {} extends Pick<DeploymentRegistryDrop, Field>
      ? false
      : true;
  };
};

/**
 * Browser-safe runtime description of the canonical row shape.
 *
 * Node-only tooling derives its accepted and required fields from this object,
 * while the mapped type keeps it exhaustive as DeploymentRegistryDrop evolves.
 * Property order matches the canonical source renderer.
 */
export const DEPLOYMENT_REGISTRY_DROP_FIELDS = {
  solanaCluster: { required: true },
  dropId: { required: true },
  dropFamily: { required: true },
  collectionName: { required: true },
  metadataBase: { required: true },
  metadataPathFormat: { required: true },
  secondaryMarketHref: { required: false },
  figureMedia: { required: false },
  boxMedia: { required: false },
  forceSoldOut: { required: false },
  mintSelection: { required: false },
  treasury: { required: true },
  priceSol: { required: true },
  discountPriceSol: { required: true },
  stripeCheckoutEnabled: { required: false },
  stripeLiveUnitAmountCents: { required: false },
  stripeProductTaxCode: { required: false },
  discountMintsPerWallet: { required: true },
  discountMerkleRoot: { required: true },
  maxSupply: { required: true },
  itemsPerBox: { required: true },
  maxPerTx: { required: true },
  namePrefix: { required: true },
  figureNamePrefix: { required: true },
  symbol: { required: true },
  boxMinterProgramId: { required: true },
  boxMinterConfigPda: { required: false },
  collectionMint: { required: true },
  receiptsMerkleTree: { required: true },
  deliveryLookupTable: { required: true },
} as const satisfies DeploymentRegistryDropFieldSpecs;

export type DeploymentDropsMap = Record<string, DeploymentRegistryDrop>;

// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY
export const DEPLOYMENT_DROPS: DeploymentDropsMap = {
  card_nft_2: {
    solanaCluster: 'mainnet-beta',
    dropId: 'card_nft_2',
    dropFamily: 'card_nft_2',
    collectionName: 'Card NFT 2',
    metadataBase: 'https://assets.mons.link/drops/cardnft2/json',
    metadataPathFormat: 'compact',
    forceSoldOut: true,
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.44,
    discountPriceSol: 0.36,
    stripeLiveUnitAmountCents: 4400,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'a8cdf1ec11dbfacb15e9859d0d1484d95f388d883c012314db51e80e5f8021d3',
    maxSupply: 3711,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'cardnft2',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: '5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm',
    collectionMint: 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu',
    receiptsMerkleTree: 'EsGrHZjZzHmxzCSrqjyzuBBC4oAq3yS87ZNF1JdvDBh',
    deliveryLookupTable: '27S1HddzYtfhYpwq4QHxnnXAkRt6JFx9Kad9KMnRUpcd',
  },
  card_nft_2_devnet_final: {
    solanaCluster: 'devnet',
    dropId: 'card_nft_2_devnet_final',
    dropFamily: 'card_nft_2',
    collectionName: 'Card NFT 2',
    metadataBase: 'https://assets.mons.link/drops/cardnft2/json',
    metadataPathFormat: 'compact',
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.44,
    discountPriceSol: 0.36,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'a8cdf1ec11dbfacb15e9859d0d1484d95f388d883c012314db51e80e5f8021d3',
    maxSupply: 3711,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'cardnft2',
    boxMinterProgramId: '7h4JRc5vELpaahm11AeshFEQHe1jePauRnMFWaPSRNpV',
    boxMinterConfigPda: 'CPDsJdtvjoYyepqK5sEtYCxmFK6Fjaga9gx7JCBqBj6y',
    collectionMint: '3iX4NjZ9b8TCi2s8xkss4sr1YwYkNhtjH4sib5kxAuEq',
    receiptsMerkleTree: '81NyUNWDpEPrzBZdxcqw1oY3fbrT6W5vW816u9nkiv25',
    deliveryLookupTable: 'Cz9S4vMFx3ZgF9NW8v1D8hZnQNWMKTyh18wUcygQrSYS',
  },
  drifella_shirt_devnet: {
    solanaCluster: 'devnet',
    dropId: 'drifella_shirt_devnet',
    dropFamily: 'drifella_shirt',
    collectionName: 'Drifella Shirt',
    metadataBase: 'https://cdn.lil.org/nft/drifella_shirt/json',
    metadataPathFormat: 'compact',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 10 },
        { key: 'XL', label: 'XL', startId: 11, endId: 23 },
        { key: '2XL', label: '2XL', startId: 24, endId: 26 },
      ],
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1.44,
    discountPriceSol: 0.069,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'f57ec834ceefb43cdfb28c79ecf907835c55b0b0e6b83031cab1f9952e018d08',
    maxSupply: 26,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'shirt',
    figureNamePrefix: 'shirt',
    symbol: 'shirt',
    boxMinterProgramId: 'Hr39xMTdeQFPkLb9D6yYxxzTTkfW6QgVyyUETT7jyfZw',
    boxMinterConfigPda: '4BkG2CssMjw6bvTCV7EykbvDRnJD4EqVAw1qJFLweVEz',
    collectionMint: 'RimmxrTuNbpvc129x9kNXJbB7dtDfjq3oKsYSLP8vkf',
    receiptsMerkleTree: 'BDsKJbsAHXjaCoL3kaeDu5M8Cr2PgsSfxVRnJrcKgf1h',
    deliveryLookupTable: '64cNojYRPCgspviUahby2Y6m4Dhba4eneoid1x7VTQhq',
  },
  little_swag_boxes: {
    solanaCluster: 'mainnet-beta',
    dropId: 'little_swag_boxes',
    dropFamily: 'little_swag_boxes',
    collectionName: 'Little Swag Boxes',
    metadataBase: 'https://assets.mons.link/drops/lsb',
    metadataPathFormat: 'legacy',
    forceSoldOut: true,
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 1,
    discountPriceSol: 0.55,
    discountMintsPerWallet: 1,
    discountMerkleRoot: '6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c',
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: 'box',
    boxMinterProgramId: '22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep',
    collectionMint: '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr',
    receiptsMerkleTree: 'Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV',
    deliveryLookupTable: 'F51Mj4JFGdVKJfdbYc4aT4de8Dbst7BmWr2P2Bwxa8Wz',
  },
  little_swag_boxes_devnet: {
    solanaCluster: 'devnet',
    dropId: 'little_swag_boxes_devnet',
    dropFamily: 'little_swag_boxes',
    collectionName: 'Little Swag Boxes',
    metadataBase: 'https://assets.mons.link/drops/lsb',
    metadataPathFormat: 'legacy',
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.1,
    discountPriceSol: 0.055,
    discountMintsPerWallet: 1,
    discountMerkleRoot: '6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c',
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: 'lsb',
    boxMinterProgramId: 'CTrBmaCdgNRE9iHtrfQJnxH2puKxfi2V3gBMTxMLrrUA',
    collectionMint: '4sdm8HbtoiV3JejDkMXxGZtiCumMHyovWyjA3SLWErG6',
    receiptsMerkleTree: '2C64cbdnyASftaTdVFYYudn94g274QZ1wv283ocRQaTT',
    deliveryLookupTable: '8JhdJPGjsgAaBdBH3sQChwtmuwUBeWxnpcCRPT4Hph9A',
  },
  little_swag_hoodies: {
    solanaCluster: 'mainnet-beta',
    dropId: 'little_swag_hoodies',
    dropFamily: 'little_swag_hoodies',
    collectionName: 'Little Swag Hoodies',
    metadataBase: 'ipfs://bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy',
    metadataPathFormat: 'compact',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 3,
    discountPriceSol: 2.55,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 21900,
    stripeProductTaxCode: 'txcd_30011000',
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871',
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
    symbol: 'hoodie',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: '3WSAzs8qN1kQoFM8eSKXAYkHXxZ3UianQDRVbVazb8Hi',
    collectionMint: '5nguer6MR8uY2SQfcQi7r6uVgw24ZXJh1vghZez9pU3o',
    receiptsMerkleTree: 'kjCLigZAjtydLvWYWoXQV7X3cM5widBkDznfZpLtEAE',
    deliveryLookupTable: '2dLo2T2JRZtH1mbSQMMUYjFGx8YrBjEkj668C8fGbou7',
  },
  little_swag_hoodies_devnet: {
    solanaCluster: 'devnet',
    dropId: 'little_swag_hoodies_devnet',
    dropFamily: 'little_swag_hoodies',
    collectionName: 'Little Swag Hoodies',
    metadataBase: 'ipfs://bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy',
    metadataPathFormat: 'compact',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: 'txcd_30011000',
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871',
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
    symbol: 'hoodie',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: 'J78XFzZ4ZZ4ykYVYofEDPD8yPc5TZxDeDrM7dikwNMZn',
    collectionMint: 'DTDkHsCGJfBAnXqR5YPbsbzegnPSF5FUh4g3ckH5hV3w',
    receiptsMerkleTree: '3JycJA4eKp611yDqCf2ZTAQwRaV7u57WAaMRWLEDd1ak',
    deliveryLookupTable: '6poyGyRRoTy1dY9qC1vo6iXy9yH7ya4SRaBZQgBxPKB6',
  },
  poncho_drifella: {
    solanaCluster: 'mainnet-beta',
    dropId: 'poncho_drifella',
    dropFamily: 'poncho_drifella',
    collectionName: 'Poncho Drifella',
    metadataBase: 'https://assets.mons.link/drops/poncho',
    metadataPathFormat: 'legacy',
    forceSoldOut: true,
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.69,
    discountPriceSol: 0.42,
    discountMintsPerWallet: 3,
    discountMerkleRoot: '57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d',
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'poncho',
    boxMinterProgramId: 'C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A',
    collectionMint: 'JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH',
    receiptsMerkleTree: '5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow',
    deliveryLookupTable: '4j1YHm1iwmYDZegY5CxJUYqBcxtpPy7UBkSUfRfz6W8c',
  },
  poncho_drifella_devnet_x10: {
    solanaCluster: 'devnet',
    dropId: 'poncho_drifella_devnet_x10',
    dropFamily: 'poncho_drifella',
    collectionName: 'Poncho Drifella',
    metadataBase: 'https://assets.mons.link/drops/poncho',
    metadataPathFormat: 'legacy',
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 3,
    discountMerkleRoot: '57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d',
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'poncho',
    boxMinterProgramId: 'J9ffqCnnV1kg2gZ7Wg4ebVW5KLFH557UDdz9Y6F8fK2W',
    boxMinterConfigPda: '9dqjCiMeTNMgYEQdoLmTwpLZHcYj1u8sN2Lcz4XiTEov',
    collectionMint: 'AKJtTjDvZUbNA5RN1HA9hbVq1Vjnmv4dSTNuL2ANxSBb',
    receiptsMerkleTree: '55oYU418GYy59eJFKYnUJFT7HKXF5K9gR1WW1Jzry7KX',
    deliveryLookupTable: 'F5tFuFeb2iQ4i42grSNjyokS2T9HxZDwMLjKRSERPgcL',
  },
};
// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY

function assertRegistryKeysMatchDropIds(drops: DeploymentDropsMap): void {
  Object.entries(drops).forEach(([registryKey, drop]) => {
    if (registryKey !== drop.dropId) {
      throw new Error(`Deployment registry key ${registryKey} does not match embedded dropId ${drop.dropId}.`);
    }
  });
}

function assertSharedProgramDropsUseExplicitConfigPdas(drops: DeploymentDropsMap): void {
  const counts = new Map<string, number>();
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    if ((counts.get(key) || 0) < 2) return;
    if (String(drop.boxMinterConfigPda || '').trim()) return;
    throw new Error(
      `Deployment registry drop ${drop.dropId} shares program ${drop.boxMinterProgramId} on ${drop.solanaCluster} and must set boxMinterConfigPda.`,
    );
  });
}

assertRegistryKeysMatchDropIds(DEPLOYMENT_DROPS);
assertSharedProgramDropsUseExplicitConfigPdas(DEPLOYMENT_DROPS);

export function getDeploymentDrop(dropId: string): DeploymentRegistryDrop | undefined {
  const normalizedDropId = String(dropId || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEPLOYMENT_DROPS, normalizedDropId)
    ? DEPLOYMENT_DROPS[normalizedDropId]
    : undefined;
}
