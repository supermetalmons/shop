import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, SystemProgram,
  TransactionMessage, type Connection,
} from '@solana/web3.js';
import { isDeepStrictEqual } from 'node:util';
import type { DeploymentRegistryDrop } from '../../shared/deploymentRegistry.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS,
} from '../../shared/solanaProgramAddresses.ts';
import {
  assertMplCoreCollectionHasUpdateDelegates, bubblegumTreeConfigPda, decodeReceiptTreeState, getConcurrentMerkleTreeAccountSize,
  IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1,
} from '../deploy-all-onchain.ts';
import { validatePreorderCollectionAccount } from '../deploy-preorder-collection.ts';
import { closedMiNotePreorderConfig } from './miNoteDropManifest.ts';
import type { PreparedPreorderCollectionConfig } from './preorderCollectionConfig.ts';
import type { TwoConfigDeploymentPlan, TwoConfigJournalTransaction } from '../deploy-two-config-drop.ts';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function approvedDelegates(value: unknown, required: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || new PublicKey(key).toBase58() !== key) ||
    new Set(value).size !== value.length || required.some(key => !value.includes(key))) {
    throw new Error('Approved collection delegates must be unique canonical keys containing the authority and both config roles.');
  }
  return [...value].sort();
}

export async function resolveMiNoteCollectionDelegates(
  record: unknown, drop: DeploymentRegistryDrop, authority: string,
): Promise<string[]> {
  if (!drop.operationsConfig || !drop.boxMinterConfigPda || !drop.inventoryManifest ||
    !object(record) || record.version !== 1 || !object(record.plan) || !object(record.drop) ||
    !Number.isSafeInteger(record.finalizedSlot) || Number(record.finalizedSlot) < 1 || !Array.isArray(record.transactions)) {
    throw new Error('Missing or invalid public two-config deployment record.');
  }
  const plan = record.plan;
  const deployed = record.drop;
  const identities = { version: 1, dropId: drop.dropId, cluster: drop.solanaCluster, authority,
    programId: drop.boxMinterProgramId, collection: drop.collectionMint, manifestSha256: drop.inventoryManifest.sha256 };
  const fields = { dropId: drop.dropId, solanaCluster: drop.solanaCluster, boxMinterProgramId: drop.boxMinterProgramId,
    collectionMint: drop.collectionMint, boxMinterConfigPda: drop.boxMinterConfigPda };
  if (Object.entries(identities).some(([key, value]) => plan[key] !== value) ||
    Object.entries(fields).some(([key, value]) => deployed[key] !== value) ||
    !isDeepStrictEqual(plan.mintConfig, { configId: drop.dropId, boxMinterConfigPda: drop.boxMinterConfigPda,
      maxSupply: drop.maxSupply, itemsPerBox: 0 }) ||
    !isDeepStrictEqual(plan.operationsConfig, { ...drop.operationsConfig, itemsPerBox: drop.itemsPerBox }) ||
    !isDeepStrictEqual(deployed.operationsConfig, drop.operationsConfig) ||
    !isDeepStrictEqual(deployed.inventoryManifest, drop.inventoryManifest)) {
    throw new Error('Approved collection delegates belong to another deployment.');
  }
  const required = [authority, drop.boxMinterConfigPda, drop.operationsConfig.boxMinterConfigPda];
  if (Object.hasOwn(record, 'collectionDelegates')) return approvedDelegates(record.collectionDelegates, required);
  const entry = record.transactions.findLast(value => object(value) && value.step === 'delegates' &&
    (value.status === 'finalized' || value.status === 'state-verified'));
  if (!entry) return approvedDelegates(required, required);
  const { validateTwoConfigJournalTransaction, buildTwoConfigDelegateUpdateInstruction } = await import('../deploy-two-config-drop.ts');
  const transaction = validateTwoConfigJournalTransaction(entry as TwoConfigJournalTransaction, authority);
  const data = TransactionMessage.decompile(transaction.message).instructions[1]?.data;
  if (!data || data.length < 6 || data[0] !== IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1 || data[1] !== 4 ||
    data.length !== 6 + data.readUInt32LE(2) * 32) throw new Error('Invalid approved collection delegate transaction.');
  const originalOrder = Array.from({ length: data.readUInt32LE(2) }, (_, index) =>
    new PublicKey(data.subarray(6 + index * 32, 38 + index * 32)).toBase58());
  const delegates = approvedDelegates(originalOrder, required);
  const expected = new TransactionMessage({ payerKey: new PublicKey(authority), recentBlockhash: transaction.message.recentBlockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      buildTwoConfigDelegateUpdateInstruction(plan as TwoConfigDeploymentPlan, originalOrder)] }).compileToV0Message();
  if (!Buffer.from(transaction.message.serialize()).equals(Buffer.from(expected.serialize()))) {
    throw new Error('Approved delegate transaction targets another collection or instruction.');
  }
  return delegates;
}

export async function verifyMiNoteMintResources(args: {
  connection: Pick<Connection, 'getMultipleAccountsInfoAndContext'>;
  drop: DeploymentRegistryDrop;
  collectionConfig: PreparedPreorderCollectionConfig;
  mintStarted: boolean;
  minimumSlot: number;
  approvedCollectionDelegates?: readonly string[];
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
  const delegates = approvedDelegates(args.approvedCollectionDelegates ??
    [config.authority, drop.boxMinterConfigPda, drop.operationsConfig.boxMinterConfigPda],
  [config.authority, drop.boxMinterConfigPda, drop.operationsConfig.boxMinterConfigPda]);
  validatePreorderCollectionAccount({ config, account: collection, collectionMint: drop.collectionMint,
    approvedCollectionDelegates: delegates });
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
