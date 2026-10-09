import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { DeploymentRegistryDrop } from '../../shared/deploymentRegistry.ts';

export function miNoteDropFixture(): DeploymentRegistryDrop {
  const dropId = 'mi_note_cards_devnet';
  const configId = `${dropId}_operations`;
  const programId = new PublicKey('8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6');
  const configPda = (id: string) => PublicKey.findProgramAddressSync([
    Buffer.from('config'), createHash('sha256').update(id).digest(),
  ], programId)[0].toBase58();
  return {
    solanaCluster: 'devnet', dropId, dropFamily: 'mi_note_cards', collectionName: 'Mi Note Cards',
    metadataBase: 'https://cdn.lil.org/nft/mi_note_cards/json/pre', metadataPathFormat: 'compact',
    treasury: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx', priceSol: 0.25, discountPriceSol: 0.25,
    stripeCheckoutEnabled: false, discountMintsPerWallet: 1, discountMerkleRoot: '0'.repeat(64),
    maxSupply: 704, itemsPerBox: 2, maxPerTx: 15, namePrefix: 'pack', figureNamePrefix: 'card', symbol: 'minote',
    boxMinterProgramId: programId.toBase58(), boxMinterConfigPda: configPda(dropId),
    operationsConfig: { configId, boxMinterConfigPda: configPda(configId), maxSupply: 715 },
    collectionMint: '65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv',
    receiptsMerkleTree: new PublicKey(new Uint8Array(32).fill(91)).toBase58(), deliveryLookupTable: '',
  };
}
