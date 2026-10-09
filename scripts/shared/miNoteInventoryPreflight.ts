import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { decodeBoxMinterConfigData } from '../../shared/boxMinterConfigCodec.ts';
import { DEPLOYMENT_DROPS, deploymentTreasuryAlias, type DeploymentRegistryDrop } from '../../shared/deploymentRegistry.ts';
import { resolveDropConfigRole } from '../../shared/dropConfigRoles.ts';
import { resolveDropMaxFigureId } from '../../shared/dropFigureIds.ts';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../shared/pendingOpenCodec.ts';
import { closedMiNotePreorderConfig, MI_NOTE_CLUSTER_GENESIS, miNoteReadOnlyConnection, type MiNoteDropManifest } from './miNoteDropManifest.ts';
import { queryRemoteOpsD1 } from './opsD1Maintenance.ts';
import { sqlString } from './commerceD1Maintenance.ts';
import { assertExistingConfigMatchesResume } from '../deploy-all-onchain.ts';

function inventoryRoles(drop: DeploymentRegistryDrop | undefined, manifest: MiNoteDropManifest) {
  const preorder = closedMiNotePreorderConfig(manifest.sourcePreorder.preorderId);
  if (!drop || drop.dropFamily !== 'mi_note_cards' || !drop.operationsConfig || drop.itemsPerBox !== 2 || drop.mintSelection ||
    drop.solanaCluster !== preorder.cluster || drop.collectionMint !== preorder.collection ||
    drop.maxSupply !== manifest.packCount || resolveDropMaxFigureId(drop) !== manifest.maxFigureId) {
    throw new Error('New Mi Note inventory requires matching mint and operations configurations in its preorder cluster.');
  }
  const mint = resolveDropConfigRole(drop, 'mint');
  const operations = resolveDropConfigRole(drop, 'operations');
  if (!mint.boxMinterConfigPda || !operations.boxMinterConfigPda || mint.boxMinterConfigPda === operations.boxMinterConfigPda ||
    mint.itemsPerBox !== 0 || operations.itemsPerBox !== 2 ||
    operations.maxSupply * operations.itemsPerBox !== manifest.maxFigureId) {
    throw new Error('Mi Note mint and operations roles are invalid.');
  }
  return { mint, operations, preorder };
}

export function validateNewMiNoteDropConfigs(
  drop: DeploymentRegistryDrop, manifest: MiNoteDropManifest, configurations: readonly Uint8Array[],
  options: { allowActiveMint?: boolean } = {},
): void {
  const { mint, operations, preorder } = inventoryRoles(drop, manifest);
  if (configurations.length !== 2) throw new Error('Both Mi Note role configurations must be verified.');
  for (const [index, role] of [mint, operations].entries()) {
    try {
      assertExistingConfigMatchesResume({
        data: Buffer.from(configurations[index]), admin: new PublicKey(preorder.authority),
        treasury: new PublicKey(deploymentTreasuryAlias(drop)), coreCollection: new PublicKey(drop.collectionMint),
        priceLamports: BigInt(Math.round(drop.priceSol * 1_000_000_000)),
        discountPriceLamports: BigInt(Math.round(drop.discountPriceSol * 1_000_000_000)),
        discountMintsPerWallet: drop.discountMintsPerWallet, discountMerkleRoot: Buffer.from(drop.discountMerkleRoot, 'hex'),
        maxSupply: role.maxSupply, itemsPerBox: role.itemsPerBox, maxPerTx: drop.maxPerTx,
        namePrefix: drop.namePrefix, figureNamePrefix: drop.figureNamePrefix, symbol: drop.symbol, metadataBase: drop.metadataBase,
        dropSeed: createHash('sha256').update(role.configId).digest(),
        allowStartedMint: index === 0 && options.allowActiveMint === true,
        ...(drop.paymentRouting ? { mintProceeds: drop.paymentRouting.mintProceeds.map(({ address, percentage }) =>
          ({ address: new PublicKey(address), percentage })) } : {}),
      });
    } catch (error) {
      const context = options.allowActiveMint
        ? 'Activation requires correct mint configuration A and unstarted, unminted operations configuration B'
        : 'Inventory initialization requires both correct configurations to remain unstarted and unminted';
      throw new Error(`${context}: ${error instanceof Error ? error.message : 'invalid configuration'}`);
    }
  }
}

export async function verifyMiNoteInventoryDrop(
  dropId: string, manifest: MiNoteDropManifest, options: { allowActiveMint?: boolean; rpcUrl?: string } = {},
): Promise<{ mintStarted: boolean; mintedPacks: number; slot: number }> {
  const drop = DEPLOYMENT_DROPS[dropId];
  const { mint, operations } = inventoryRoles(drop, manifest);
  const connection = miNoteReadOnlyConnection(manifest.sourcePreorder.cluster, options.rpcUrl);
  if (await connection.getGenesisHash() !== MI_NOTE_CLUSTER_GENESIS[manifest.sourcePreorder.cluster]) {
    throw new Error('Inventory verification RPC has the wrong cluster genesis.');
  }
  const roles = [mint, operations];
  const accounts = await connection.getMultipleAccountsInfoAndContext(roles.map((role) => new PublicKey(role.boxMinterConfigPda!)), {
    commitment: 'finalized',
  });
  const configurations = roles.map((_role, index) => {
    const account = accounts.value[index];
    if (!account || account.executable || account.owner.toBase58() !== drop.boxMinterProgramId) {
      throw new Error('Inventory role configuration is missing or belongs to another program.');
    }
    return account.data;
  });
  validateNewMiNoteDropConfigs(drop, manifest, configurations, options);
  const mintState = decodeBoxMinterConfigData(configurations[0]);
  const result = { mintStarted: mintState.started, mintedPacks: mintState.minted, slot: accounts.context.slot };
  if (mintState.started) return result;
  const targets = [...new Set([dropId, mint.configId, operations.configId])];
  const submissions = queryRemoteOpsD1(`SELECT COUNT(*) AS count FROM reveal_submissions
    WHERE drop_id IN (${targets.map(sqlString).join(', ')})`);
  if (submissions.length !== 1 || submissions[0].count !== 0) {
    throw new Error('New Mi Note inventory already has public reveal submissions.');
  }
  const configOffset = 8 + 32 + 32 + 4 + 32 * operations.itemsPerBox + 8 + 1;
  const pending = await connection.getProgramAccounts(new PublicKey(drop.boxMinterProgramId), {
    commitment: 'finalized', withContext: true, minContextSlot: accounts.context.slot,
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(PENDING_OPEN_BOX_DISCRIMINATOR) } },
      { memcmp: { offset: configOffset, bytes: operations.boxMinterConfigPda } }],
  });
  if (pending.value.length) throw new Error('New Mi Note inventory already has pending public pack opens.');
  return result;
}

export async function verifyNewMiNoteInventoryDrop(dropId: string, manifest: MiNoteDropManifest): Promise<void> {
  await verifyMiNoteInventoryDrop(dropId, manifest);
}
