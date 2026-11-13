import { PublicKey, SystemProgram, TransactionInstruction, type Commitment, type Connection } from '@solana/web3.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../shared/solanaProgramAddresses.ts';
import { canRead, u32LE } from './solanaInstructionData.ts';
import {
  decodeMplCoreCollectionBase,
  decodeMplCoreCollectionRoyalties,
  decodeMplCoreCollectionUpdateDelegates,
  MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY,
  readMplCoreCollectionPluginRecords,
} from './mplCoreCollection.ts';
import { retryRpcRead } from './solanaRpcRead.ts';

const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);

export function getConcurrentMerkleTreeAccountSize(maxDepth: number, maxBufferSize: number, canopyDepth: number): number {
  // Matches @solana/spl-account-compression sizing (ConcurrentMerkleTreeHeaderDataV1 + tree + optional canopy).
  const headerSize = 4 + 4 + 32 + 8 + 1 + 5;
  const nodeSize = 40 + 32 * maxDepth;
  const treeSize = 24 + (maxBufferSize + 1) * nodeSize;
  const canopySize = canopyDepth > 0 ? Math.max((Math.pow(2, canopyDepth + 1) - 2) * 32, 0) : 0;
  return 2 + headerSize + treeSize + canopySize;
}

const IX_BUBBLEGUM_CREATE_TREE_CONFIG_V2 = Buffer.from([55, 99, 95, 215, 142, 203, 227, 205]);

export function bubblegumTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

export function buildCreateBubblegumTreeConfigV2Ix(args: {
  merkleTree: PublicKey;
  payer: PublicKey;
  treeCreator: PublicKey;
  maxDepth: number;
  maxBufferSize: number;
  // If undefined/null, encodes Option::None (private tree).
  isPublic?: boolean | null;
}): TransactionInstruction {
  const treeConfig = bubblegumTreeConfigPda(args.merkleTree);
  const publicOpt = args.isPublic == null ? Buffer.from([0]) : Buffer.from([1, args.isPublic ? 1 : 0]);
  const data = Buffer.concat([
    IX_BUBBLEGUM_CREATE_TREE_CONFIG_V2,
    u32LE(args.maxDepth),
    u32LE(args.maxBufferSize),
    publicOpt,
  ]);

  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.merkleTree, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.treeCreator, isSigner: true, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export type DecodedReceiptTreeState = {
  maxDepth: number;
  maxBufferSize: number;
  authority: PublicKey;
  creator: PublicKey;
  delegate: PublicKey;
  totalCapacity: number;
  numMinted: number;
  isPublic: boolean;
  version: number;
};

const BUBBLEGUM_TREE_CONFIG_V2_DISCRIMINATOR = Buffer.from([
  122, 245, 175, 248, 171, 34, 0, 207,
]);

function readSafeU64(data: Buffer, offset: number, label: string): number {
  if (!canRead(data, offset, 8)) {
    throw new Error(`Truncated ${label}`);
  }
  const value = data.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  return Number(value);
}

export function decodeReceiptTreeState(args: {
  merkleTreeData: Buffer;
  treeConfigData: Buffer;
}): DecodedReceiptTreeState {
  const merkle = args.merkleTreeData;
  const config = args.treeConfigData;
  if (merkle.length < 56 || merkle[0] !== 1 || merkle[1] !== 0) {
    throw new Error('Invalid concurrent Merkle tree account header');
  }
  if (
    config.length < 96 ||
    !config
      .subarray(0, BUBBLEGUM_TREE_CONFIG_V2_DISCRIMINATOR.length)
      .equals(BUBBLEGUM_TREE_CONFIG_V2_DISCRIMINATOR)
  ) {
    throw new Error('Invalid Bubblegum TreeConfig account');
  }
  return {
    maxBufferSize: merkle.readUInt32LE(2),
    maxDepth: merkle.readUInt32LE(6),
    authority: new PublicKey(merkle.subarray(10, 42)),
    creator: new PublicKey(config.subarray(8, 40)),
    delegate: new PublicKey(config.subarray(40, 72)),
    totalCapacity: readSafeU64(config, 72, 'TreeConfig totalCapacity'),
    numMinted: readSafeU64(config, 80, 'TreeConfig numMinted'),
    isPublic: config[88] !== 0,
    version: config[90],
  };
}

export function assertReceiptPoolCollectionUpdateDelegatePolicy(args: {
  data: Buffer;
  authority: PublicKey;
}): void {
  const updateDelegate = decodeMplCoreCollectionUpdateDelegates(args.data);
  if (
    !updateDelegate ||
    updateDelegate.authorityKind !==
      MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY ||
    updateDelegate.delegates.length !== 1 ||
    !updateDelegate.delegates[0].equals(args.authority)
  ) {
    throw new Error(
      'Receipt pool collection must delegate only to its fixed authority',
    );
  }
}

export async function validateReceiptPoolDeploymentOnchain(args: {
  connection: Connection;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  authority: PublicKey;
  collectionMetadataUri: string;
  collectionName: string;
  royaltiesBasisPoints: number;
  royaltiesRecipient: PublicKey;
  receiptsTreeMaxDepth: number;
  receiptsTreeMaxBufferSize: number;
  receiptsTreeCanopyDepth: number;
  commitment?: Commitment;
}): Promise<DecodedReceiptTreeState> {
  const commitment = args.commitment || 'confirmed';
  const treeConfig = bubblegumTreeConfigPda(args.receiptsMerkleTree);
  const [collectionInfo, merkleTreeInfo, treeConfigInfo] =
    await retryRpcRead('getMultipleAccountsInfo(receipt pool)', () =>
      args.connection.getMultipleAccountsInfo(
        [args.collectionMint, args.receiptsMerkleTree, treeConfig],
        { commitment },
      ),
    );
  if (!collectionInfo) {
    throw new Error(
      `Missing receipt pool collection ${args.collectionMint.toBase58()}`,
    );
  }
  if (!collectionInfo.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new Error('Receipt pool collection has the wrong owner');
  }
  if (!merkleTreeInfo) {
    throw new Error(
      `Missing receipt pool Merkle tree ${args.receiptsMerkleTree.toBase58()}`,
    );
  }
  if (!merkleTreeInfo.owner.equals(MPL_ACCOUNT_COMPRESSION_PROGRAM_ID)) {
    throw new Error('Receipt pool Merkle tree has the wrong owner');
  }
  if (!treeConfigInfo) {
    throw new Error(`Missing receipt pool TreeConfig ${treeConfig.toBase58()}`);
  }
  if (!treeConfigInfo.owner.equals(BUBBLEGUM_PROGRAM_ID)) {
    throw new Error('Receipt pool TreeConfig has the wrong owner');
  }

  const collection = decodeMplCoreCollectionBase(
    Buffer.from(collectionInfo.data),
  );
  if (!collection.updateAuthority.equals(args.authority)) {
    throw new Error('Receipt pool collection update authority mismatch');
  }
  if (
    collection.name !== args.collectionName ||
    collection.uri !== args.collectionMetadataUri
  ) {
    throw new Error(
      `Receipt pool collection identity mismatch: ${collection.name} ${collection.uri}`,
    );
  }
  const pluginRecords = readMplCoreCollectionPluginRecords(
    Buffer.from(collectionInfo.data),
  );
  if (!pluginRecords?.some((record) => record.pluginType === 15)) {
    throw new Error('Receipt pool collection is missing BubblegumV2');
  }
  const royalties = decodeMplCoreCollectionRoyalties(
    Buffer.from(collectionInfo.data),
  );
  if (
    !royalties ||
    royalties.basisPoints !== args.royaltiesBasisPoints ||
    royalties.ruleSetKind !== 0 ||
    royalties.authorityKind !==
      MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY ||
    royalties.creators.length !== 1 ||
    !royalties.creators[0].address.equals(args.royaltiesRecipient) ||
    royalties.creators[0].percentage !== 100
  ) {
    throw new Error('Receipt pool collection royalties mismatch');
  }
  assertReceiptPoolCollectionUpdateDelegatePolicy({
    data: Buffer.from(collectionInfo.data),
    authority: args.authority,
  });

  const tree = decodeReceiptTreeState({
    merkleTreeData: Buffer.from(merkleTreeInfo.data),
    treeConfigData: Buffer.from(treeConfigInfo.data),
  });
  const expectedTreeSize = getConcurrentMerkleTreeAccountSize(
    args.receiptsTreeMaxDepth,
    args.receiptsTreeMaxBufferSize,
    args.receiptsTreeCanopyDepth,
  );
  if (merkleTreeInfo.data.length !== expectedTreeSize) {
    throw new Error(
      `Receipt pool Merkle tree size mismatch: expected ${expectedTreeSize}, got ${merkleTreeInfo.data.length}`,
    );
  }
  if (
    tree.maxDepth !== args.receiptsTreeMaxDepth ||
    tree.maxBufferSize !== args.receiptsTreeMaxBufferSize ||
    !tree.authority.equals(treeConfig) ||
    !tree.creator.equals(args.authority) ||
    !tree.delegate.equals(args.authority) ||
    tree.totalCapacity !== 2 ** args.receiptsTreeMaxDepth ||
    tree.numMinted > tree.totalCapacity ||
    tree.isPublic ||
    tree.version !== 1
  ) {
    throw new Error('Receipt pool Merkle tree configuration mismatch');
  }
  return tree;
}
