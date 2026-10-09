import { readFileSync } from 'node:fs';
import { defineNewDropConfig, type NewDropConfigInput } from '../shared/newDropConfig.ts';
import { parseMiNoteDropManifest } from '../shared/miNoteDropManifest.ts';
import { NEW_PREORDER_COLLECTION } from '../newPreorderCollections/mi_note_cards_devnet.ts';
import { PREORDER_PAYMENT_RECIPIENTS, getPreorderConfig } from '../../shared/preorders.ts';

const preorder = getPreorderConfig('mi_note_cards_devnet')!;
const manifest = parseMiNoteDropManifest(JSON.parse(readFileSync(
  new URL('../../releases/mi-note-cards-devnet/inventory.json', import.meta.url), 'utf8',
)));
if (manifest.sourcePreorder.preorderId !== preorder.preorderId || manifest.sourcePreorder.cluster !== 'devnet' ||
  manifest.sourcePreorder.collection !== preorder.collection || manifest.packCount !== 704 || manifest.maxFigureId !== 1430) {
  throw new Error('The Mi Note devnet deployment requires its reviewed 704-pack inventory manifest.');
}

export const NEW_DROP_INPUT = {
  shared: { isMainnet: false, dropSymbol: 'minote', sellerFeeBasisPoints: 500 },
  deploy: {
    reuseProgramId: true,
    reuseProgramIdFromDropId: 'clear_cards_devnet_v3',
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
      configId: 'mi_note_cards_devnet_operations',
      maxSupply: Math.ceil(manifest.maxFigureId / manifest.itemsPerPack),
    },
    inventoryManifest: { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds },
    discountWhitelistCsvRelativePath: 'scripts/discounts/mi_note_cards.csv',
    receiptsTree: { maxDepth: 14, maxBufferSize: 64, canopyDepth: 0 },
    paymentRouting: {
      mintProceeds: [
        { address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 },
        { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 },
      ],
      deliveryPaymentReceiver: preorder.authority,
    },
    priceSol: 0.25,
    discountPriceSol: 0.25,
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
