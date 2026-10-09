import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, SystemProgram, type Connection,
} from '@solana/web3.js';
import type { DeploymentRegistryDrop } from '../../shared/deploymentRegistry.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS,
} from '../../shared/solanaProgramAddresses.ts';
import {
  assertMplCoreCollectionHasUpdateDelegates, bubblegumTreeConfigPda, decodeReceiptTreeState, getConcurrentMerkleTreeAccountSize,
} from '../deploy-all-onchain.ts';
import { validatePreorderCollectionAccount } from '../deploy-preorder-collection.ts';
import { closedMiNotePreorderConfig } from './miNoteDropManifest.ts';
import type { PreparedPreorderCollectionConfig } from './preorderCollectionConfig.ts';

export async function verifyMiNoteMintResources(args: {
  connection: Pick<Connection, 'getMultipleAccountsInfoAndContext'>;
  drop: DeploymentRegistryDrop;
  collectionConfig: PreparedPreorderCollectionConfig;
  mintStarted: boolean;
  minimumSlot: number;
}): Promise<void> {
  const { drop, collectionConfig: config } = args;
  if (!drop.operationsConfig || !drop.boxMinterConfigPda || !drop.deliveryLookupTable ||
    drop.receiptsTreeMaxDepth !== 14 || drop.receiptsTreeCanopyDepth !== 0 ||
    config.collectionId !== drop.dropId || config.solanaCluster !== drop.solanaCluster ||
    config.authority !== closedMiNotePreorderConfig(drop.dropId).authority) {
    throw new Error('Activation requires the committed Mi Note collection, receipt tree, and lookup table.');
  }
  const treeKey = new PublicKey(drop.receiptsMerkleTree);
  const treeConfigKey = bubblegumTreeConfigPda(treeKey);
  const addresses = [new PublicKey(drop.collectionMint), treeKey, treeConfigKey, new PublicKey(drop.deliveryLookupTable)];
  const result = await args.connection.getMultipleAccountsInfoAndContext(addresses, {
    commitment: 'finalized', minContextSlot: args.minimumSlot,
  });
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < args.minimumSlot || result.value.length !== addresses.length) {
    throw new Error('Activation resources returned stale or incomplete finalized state.');
  }
  const [collection, merkle, treeConfig, lookup] = result.value;
  validatePreorderCollectionAccount({ config, account: collection, collectionMint: drop.collectionMint });
  assertMplCoreCollectionHasUpdateDelegates({ data: collection!.data, collection: drop.collectionMint,
    requiredDelegates: [config.authority, drop.boxMinterConfigPda, drop.operationsConfig.boxMinterConfigPda].map(value => new PublicKey(value)) });
  if (!merkle || !treeConfig || merkle.executable || treeConfig.executable ||
    merkle.owner.toBase58() !== MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS || treeConfig.owner.toBase58() !== BUBBLEGUM_PROGRAM_ADDRESS ||
    merkle.data.length !== getConcurrentMerkleTreeAccountSize(14, 64, 0)) {
    throw new Error('Activation receipt tree or TreeConfig is missing or has the wrong owner or size.');
  }
  const tree = decodeReceiptTreeState({ merkleTreeData: merkle.data, treeConfigData: treeConfig.data });
  if (tree.maxDepth !== 14 || tree.maxBufferSize !== 64 || tree.version !== 1 || !tree.authority.equals(treeConfigKey) ||
    tree.creator.toBase58() !== config.authority || tree.delegate.toBase58() !== config.authority ||
    tree.totalCapacity !== 2 ** 14 || tree.numMinted > tree.totalCapacity || !args.mintStarted && tree.numMinted !== 0 || tree.isPublic) {
    throw new Error('Activation receipt tree must be private, correctly controlled, and unused before the first activation.');
  }
  if (!lookup || lookup.executable || !lookup.owner.equals(AddressLookupTableProgram.programId)) {
    throw new Error('Activation lookup table is missing or has the wrong owner.');
  }
  const table = AddressLookupTableAccount.deserialize(lookup.data);
  const required = [...new Set([
    drop.boxMinterProgramId, drop.boxMinterConfigPda, drop.operationsConfig.boxMinterConfigPda,
    config.authority, drop.paymentRouting?.deliveryPaymentReceiver ?? drop.treasury!, drop.collectionMint,
    MPL_CORE_PROGRAM_ADDRESS, SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
    SPL_NOOP_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
    BUBBLEGUM_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS, treeKey.toBase58(), treeConfigKey.toBase58(),
  ])];
  if (table.authority?.toBase58() !== config.authority || table.deactivationSlot !== 0xffff_ffff_ffff_ffffn ||
    table.lastExtendedSlot >= result.context.slot || table.addresses.length !== required.length ||
    table.addresses.some((address, index) => address.toBase58() !== required[index])) {
    throw new Error('Activation lookup table must be active and contain the committed resources for both config roles.');
  }
}
