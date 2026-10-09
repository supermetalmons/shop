import type { NewDropConfigInput } from '../../shared/newDropConfig.ts';

export const NEW_DROP_INPUT = {
  shared: {
    isMainnet: false,
    dropSymbol: 'pack',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'replace_pack_devnet',
    dropFamily: 'default',
    metadataBase: 'https://example.com/replace_pack/json',
    collectionMetadata: {
      name: 'REPLACE_COLLECTION_NAME',
      description: 'REPLACE_COLLECTION_DESCRIPTION',
      externalUrl: 'https://example.com',
      image: 'https://example.com/replace_pack/cover.png',
    },
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    paymentRouting: {
      mintProceeds: [
        { address: 'REPLACE_MINT_RECIPIENT_1', percentage: 70 },
        { address: 'REPLACE_MINT_RECIPIENT_2', percentage: 30 },
      ],
      deliveryPaymentReceiver: 'REPLACE_DELIVERY_RECEIVER',
    },
    priceSol: 0.1,
    discountPriceSol: 0.1,
    stripeCheckoutEnabled: false,
    discountMintsPerWallet: 1,
    maxSupply: 100,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
} satisfies NewDropConfigInput;
