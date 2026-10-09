import { PublicKey } from '@solana/web3.js';
import { getPreorderConfig } from '../../shared/preorders.ts';
import {
  MI_NOTE_CLUSTER_GENESIS, prepareMiNoteDropManifest,
  type MiNotePreorderChainSnapshot, type MiNotePreorderSnapshot,
} from '../../scripts/shared/miNoteDropManifest.ts';

export function miNoteManifestFixture(preorderId: 'mi_note_cards_devnet' | 'mi_note_cards' = 'mi_note_cards_devnet') {
  const config = getPreorderConfig(preorderId)!;
  const catalogText = JSON.stringify({
    ethereumCollections: [{ tokens: [1, 2, 3, 4, 1430].map((id) => ({ clean_card_id: id, name: `art ${id}` })) }],
    specialCards: [{ clean_card_id: 1401, name: 'special artwork' }],
  });
  const assets = [1, 4].map((id) => ({ id, address: new PublicKey(new Uint8Array(32).fill(id)).toBase58() }));
  const snapshot: MiNotePreorderSnapshot = {
    orders: [{ orderId: 'order', preorderId: config.preorderId, cluster: config.cluster, collection: config.collection,
      status: 'succeeded', revision: 3, cardIds: [1, 4], assets }],
    claims: [1, 4].map((id) => ({ id, orderId: 'order', cluster: config.cluster, collection: config.collection })),
  };
  const chain: MiNotePreorderChainSnapshot = {
    genesisHash: MI_NOTE_CLUSTER_GENESIS[config.cluster as keyof typeof MI_NOTE_CLUSTER_GENESIS], slot: 1234,
    assets: assets.map((asset) => ({ ...asset, name: `Preorder #${asset.id}`,
      collection: config.collection, uri: `${config.metadataBase}${asset.id}.json` })),
  };
  const dependencies = {
    query: (_sql: string) => [{ snapshot_json: JSON.stringify(snapshot) }],
    catalogText: () => catalogText,
    chain: async () => chain,
    now: () => new Date('2026-10-09T10:00:00.000Z'),
  };
  return { config, catalogText, snapshot, chain, dependencies, manifest: () => prepareMiNoteDropManifest(config.preorderId, dependencies) };
}
