import { readFileSync } from 'node:fs';
import { defineNewDropConfig, type NewDropConfigInput } from '../shared/newDropConfig.ts';
import { parseMiNoteDropManifest } from '../shared/miNoteDropManifest.ts';
import { NEW_PREORDER_COLLECTION } from '../newPreorderCollections/mi_note_cards.ts';
import { PREORDER_PAYMENT_RECIPIENTS, getPreorderConfig } from '../../shared/preorders.ts';

const preorder = getPreorderConfig('mi_note_cards')!;
const manifest = parseMiNoteDropManifest(JSON.parse(readFileSync(
  new URL('../../releases/mi-note-cards/inventory.json', import.meta.url), 'utf8',
)));
if (manifest.sourcePreorder.preorderId !== preorder.preorderId || manifest.sourcePreorder.cluster !== 'mainnet-beta' ||
  manifest.sourcePreorder.collection !== preorder.collection || manifest.packCount !== 627 || manifest.maxFigureId !== 1430 ||
  manifest.excludedCardIds.length !== 176 || manifest.eligibleCardIds.length !== 1254) {
  throw new Error('The Mi Note mainnet deployment requires its reviewed 627-pack inventory manifest with 176 preorder exclusions.');
}

export const NEW_DROP_INPUT = {
  shared: { isMainnet: true, dropSymbol: 'minote', sellerFeeBasisPoints: 500 },
  deploy: {
    reuseProgramId: true,
    reuseProgramIdFromDropId: 'card_nft_2',
    coreCollectionPubkey: preorder.collection,
    grantCollectionUpdateDelegate: true,
    preserveCollectionMetadata: true,
  },
  onchain: {
    dropId: preorder.preorderId,
    dropFamily: 'mi_note_cards',
    metadataBase: manifest.metadataBase,
    collectionMetadataUri: NEW_PREORDER_COLLECTION.collectionMetadataUri,
    collectionMetadata: NEW_PREORDER_COLLECTION.collectionMetadata,
    operationsConfig: {
      configId: 'mi_note_cards_operations',
      maxSupply: Math.ceil(manifest.maxFigureId / manifest.itemsPerPack),
    },
    inventoryManifest: { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds },
    receiptsTree: { maxDepth: 14, maxBufferSize: 64, canopyDepth: 0 },
    paymentRouting: {
      mintProceeds: [
        { address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 },
        { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 },
      ],
      deliveryPaymentReceiver: PREORDER_PAYMENT_RECIPIENTS[1],
    },
    priceSol: 0.5,
    discountPriceSol: 0.5,
    stripeCheckoutEnabled: false,
    discountMintsPerWallet: 1,
    maxSupply: manifest.packCount,
    itemsPerBox: manifest.itemsPerPack,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
} satisfies NewDropConfigInput;

export const NEW_DROP = defineNewDropConfig(NEW_DROP_INPUT);
