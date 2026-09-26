import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import {
  PREORDER_PAYMENT_RECIPIENTS,
  isPreorderCardId,
  preorderMetadataUri,
  type PreorderAsset,
  type PreorderConfig,
} from '../../../../shared/preorders.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { ProfileReadError } from './dataAccess.js';
import { createSolanaConnection } from './solanaConnection.js';
import { SOLANA_MAX_RAW_TX_BYTES } from './solanaTransaction.js';

const CORE_PROGRAM = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

type ProviderArgs = {
  config: PreorderConfig;
  apiKey: string;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
};

type PreorderConnection = Pick<Connection,
  'getGenesisHash' | 'getMultipleAccountsInfoAndContext' | 'getLatestBlockhashAndContext' |
  'simulateTransaction' | 'isBlockhashValid' | 'getSignatureStatuses' | 'getTransaction' |
  'getEpochInfo' | 'getFirstAvailableBlock' | 'getMinimumLedgerSlot' | 'sendRawTransaction'
>;

type Dependencies = {
  createConnection: (args: ProviderArgs) => PreorderConnection;
  generateAsset: () => Keypair;
  verifyArchivedAbsence?: (args: {
    signature: string; blockhashContextSlot: number; lastValidBlockHeight: number; finalizedSlot: number;
  }) => Promise<boolean>;
};

type PreparedPreorderTransaction = {
  transactionBase64: string;
  assets: PreorderAsset[];
  blockhash: string;
  lastValidBlockHeight: number;
  blockhashContextSlot: number;
};

function invalid(message: string): ProfileReadError {
  return new ProfileReadError('invalid-argument', 400, message);
}

function unavailable(message: string): ProfileReadError {
  return new ProfileReadError('unavailable', 503, message);
}

function assertEnabled(config: PreorderConfig): void {
  if (!config.enabled || config.cluster !== 'devnet' && config.cluster !== 'mainnet-beta') {
    throw new ProfileReadError('failed-precondition', 412, 'Preorders are not enabled for this collection.');
  }
}

function connectionFor(args: ProviderArgs): PreorderConnection {
  assertEnabled(args.config);
  if (!args.apiKey.trim()) throw unavailable('Preorder provider is not configured.');
  return createSolanaConnection({
    ...args,
    cluster: args.config.cluster,
    mapError: (failure) => new ProfileReadError(
      failure.kind === 'timeout' ? 'deadline-exceeded' : 'unavailable',
      failure.kind === 'timeout' ? 504 : 503,
      'Preorder provider is temporarily unavailable.',
    ),
  });
}

function dependencies(overrides: Partial<Dependencies>): Dependencies {
  return { createConnection: connectionFor, generateAsset: () => Keypair.generate(), ...overrides };
}

function publicKey(value: string, field: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value || key.equals(PublicKey.default)) throw new Error('invalid');
    return key;
  } catch {
    throw invalid(`${field} must be a valid public key.`);
  }
}

function cosigner(secret: string, authority: string): Keypair {
  let key: Keypair;
  try {
    const bytes = bs58.decode(secret.trim());
    if (bytes.length !== 64) throw new Error('invalid');
    key = Keypair.fromSecretKey(bytes);
  } catch {
    throw unavailable('Preorder signing is not configured correctly.');
  }
  if (key.publicKey.toBase58() !== authority) {
    throw unavailable('Preorder signer does not match the collection authority.');
  }
  return key;
}

function stringBytes(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length);
  return Buffer.concat([length, encoded]);
}

export function decodePreorderAssetAccount(data: Uint8Array): {
  owner: string;
  collection: string;
  name: string;
  uri: string;
} | null {
  if (data.length < 75 || data[0] !== 1 || data[33] !== 2) return null;
  try {
    const bytes = Buffer.from(data);
    let offset = 66;
    const readString = () => {
      if (offset + 4 > bytes.length) throw new Error('truncated');
      const length = bytes.readUInt32LE(offset);
      offset += 4;
      if (length > 2048 || offset + length > bytes.length) throw new Error('truncated');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    };
    const name = readString();
    const uri = readString();
    const sequence = bytes[offset];
    if (sequence !== 0 && sequence !== 1 || sequence === 1 && offset + 9 > bytes.length) return null;
    return {
      owner: new PublicKey(bytes.subarray(1, 33)).toBase58(),
      collection: new PublicKey(bytes.subarray(34, 66)).toBase58(),
      name,
      uri,
    };
  } catch {
    return null;
  }
}

function createAssetInstruction(config: PreorderConfig, buyer: PublicKey, asset: PreorderAsset): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM,
    keys: [
      { pubkey: new PublicKey(asset.address), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(config.collection), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(config.authority), isSigner: true, isWritable: false },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: buyer, isSigner: false, isWritable: false },
      { pubkey: CORE_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: CORE_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([20, 0]),
      stringBytes(`Preorder #${asset.id}`),
      stringBytes(preorderMetadataUri(config, asset.id)),
      Buffer.from([0, 0]),
    ]),
  });
}

function transactionBytes(transaction: VersionedTransaction): Buffer {
  const bytes = Buffer.from(transaction.serialize());
  if (bytes.length > SOLANA_MAX_RAW_TX_BYTES) throw invalid('Preorder transaction is too large.');
  return bytes;
}

function decodeTransaction(encoded: string): VersionedTransaction {
  try {
    if (typeof encoded !== 'string' || encoded.length > 1_644 || !encoded.length) throw new Error('invalid');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length > SOLANA_MAX_RAW_TX_BYTES) throw new Error('invalid');
    const transaction = VersionedTransaction.deserialize(bytes);
    if (transaction.version !== 0 || !transactionBytes(transaction).equals(bytes)) throw new Error('invalid');
    return transaction;
  } catch {
    throw invalid('Invalid preorder transaction.');
  }
}

function validSignature(transaction: VersionedTransaction, index: number): boolean {
  return nacl.sign.detached.verify(
    transaction.message.serialize(),
    transaction.signatures[index],
    transaction.message.staticAccountKeys[index].toBytes(),
  );
}

function verifyAllSignatures(transaction: VersionedTransaction): void {
  for (let index = 0; index < transaction.signatures.length; index += 1) {
    if (!validSignature(transaction, index)) throw invalid('Invalid preorder transaction signature.');
  }
}

async function verifyCluster(connection: PreorderConnection, config: PreorderConfig): Promise<void> {
  const expectedGenesis = config.cluster === 'devnet' ? DEVNET_GENESIS : MAINNET_GENESIS;
  if (await connection.getGenesisHash() !== expectedGenesis) {
    throw unavailable('Preorder RPC is connected to the wrong cluster.');
  }
}

export async function preparePreorderTransaction(
  args: ProviderArgs & { buyer: string; ids: number[]; cosignerSecret: string },
  overrides: Partial<Dependencies> = {},
): Promise<PreparedPreorderTransaction> {
  assertEnabled(args.config);
  if (
    args.ids.length < 1 || args.ids.length > Math.min(3, args.config.maxItems) ||
    new Set(args.ids).size !== args.ids.length ||
    args.ids.some((id) => !isPreorderCardId(id))
  ) throw invalid('Select between one and three different preorder cards.');
  if (args.config.unitPriceLamports !== 250_000_000) throw unavailable('Preorder pricing is not configured correctly.');
  const buyer = publicKey(args.buyer, 'Buyer');
  if (!PublicKey.isOnCurve(buyer.toBytes())) throw invalid('Buyer must be a signing wallet.');
  if (args.buyer === args.config.authority) throw invalid('Use a buyer wallet separate from the collection authority.');
  cosigner(args.cosignerSecret, args.config.authority);
  const deps = dependencies(overrides);
  const connection = deps.createConnection(args);
  await verifyCluster(connection, args.config);
  const chain = await connection.getMultipleAccountsInfoAndContext([
    CORE_PROGRAM, publicKey(args.config.collection, 'Collection'),
  ], { commitment: 'confirmed' });
  const [program, collection] = chain.value;
  if (!program?.executable) throw unavailable('Metaplex Core is not available.');
  if (
    !collection || collection.executable || !collection.owner.equals(CORE_PROGRAM) ||
    collection.data.length < 49 || collection.data[0] !== 5 ||
    new PublicKey(collection.data.subarray(1, 33)).toBase58() !== args.config.authority
  ) throw unavailable('Preorder collection authority could not be verified.');
  const signers = args.ids.map(() => deps.generateAsset());
  const assets = args.ids.map((id, index) => ({ id, address: signers[index].publicKey.toBase58() }));
  if (
    new Set(assets.map((asset) => asset.address)).size !== assets.length ||
    assets.some((asset) => asset.address === args.buyer || asset.address === args.config.authority || asset.address === args.config.collection)
  ) throw unavailable('Preorder asset generation failed.');
  const latest = await connection.getLatestBlockhashAndContext({ commitment: 'confirmed', minContextSlot: chain.context.slot });
  if (latest.context.slot < chain.context.slot) throw unavailable('Preorder provider returned stale blockhash data.');
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ...PREORDER_PAYMENT_RECIPIENTS.map((recipient) => SystemProgram.transfer({
      fromPubkey: buyer,
      toPubkey: new PublicKey(recipient),
      lamports: args.config.unitPriceLamports / 2 * assets.length,
    })),
    ...assets.map((asset) => createAssetInstruction(args.config, buyer, asset)),
  ];
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: buyer,
    recentBlockhash: latest.value.blockhash,
    instructions,
  }).compileToV0Message());
  transaction.sign(signers);
  const transactionBase64 = transactionBytes(transaction).toString('base64');
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed', sigVerify: false, minContextSlot: latest.context.slot,
  });
  if (simulation.context.slot < latest.context.slot) throw unavailable('Preorder provider returned a stale simulation.');
  if (simulation.value.err) {
    const network = args.config.cluster === 'devnet' ? 'devnet SOL' : 'SOL';
    throw new ProfileReadError('failed-precondition', 412, `Preorder simulation failed. Check your ${network} balance and retry.`);
  }
  return {
    transactionBase64,
    assets,
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    blockhashContextSlot: latest.context.slot,
  };
}

export function authorizePreorderTransaction(args: {
  preparedTransactionBase64: string;
  signedTransactionBase64: string;
  buyer: string;
  cosignerSecret: string;
  authority: string;
}): { transactionBase64: string; signature: string } {
  const prepared = decodeTransaction(args.preparedTransactionBase64);
  const signed = decodeTransaction(args.signedTransactionBase64);
  if (!Buffer.from(prepared.message.serialize()).equals(Buffer.from(signed.message.serialize()))) {
    throw invalid('Signed transaction does not match the prepared preorder.');
  }
  const buyer = publicKey(args.buyer, 'Buyer');
  if (args.buyer === args.authority) throw invalid('Use a buyer wallet separate from the collection authority.');
  if (!signed.message.staticAccountKeys[0].equals(buyer)) throw invalid('Preorder buyer does not match the transaction.');
  const signer = cosigner(args.cosignerSecret, args.authority);
  const authorityIndex = signed.message.staticAccountKeys.slice(0, signed.signatures.length)
    .findIndex((key) => key.equals(signer.publicKey));
  if (authorityIndex < 0 || prepared.signatures[authorityIndex].some((byte) => byte !== 0)) {
    throw invalid('Prepared preorder has an invalid authority signature.');
  }
  for (let index = 0; index < signed.signatures.length; index += 1) {
    if (index === authorityIndex) {
      if (signed.signatures[index].some((byte) => byte !== 0)) throw invalid('Preorder authority must sign on the server.');
    } else if (!validSignature(signed, index)) {
      throw invalid(index === 0 ? 'Invalid buyer signature.' : 'Invalid preorder asset signature.');
    }
    if (index !== 0 && index !== authorityIndex && !Buffer.from(prepared.signatures[index]).equals(Buffer.from(signed.signatures[index]))) {
      throw invalid('Preorder asset signature changed.');
    }
  }
  signed.sign([signer]);
  verifyAllSignatures(signed);
  return { transactionBase64: transactionBytes(signed).toString('base64'), signature: bs58.encode(signed.signatures[0]) };
}

export async function isPreorderBlockhashValid(
  args: ProviderArgs & { blockhash: string; minContextSlot: number },
  overrides: Partial<Dependencies> = {},
): Promise<boolean> {
  assertEnabled(args.config);
  const connection = dependencies(overrides).createConnection(args);
  await verifyCluster(connection, args.config);
  const result = await connection.isBlockhashValid(args.blockhash, { commitment: 'confirmed', minContextSlot: args.minContextSlot });
  if (result.context.slot < args.minContextSlot) throw unavailable('Preorder provider returned stale blockhash data.');
  return result.value;
}

export async function sendPreorderTransaction(
  args: ProviderArgs & { transactionBase64: string },
  overrides: Partial<Dependencies> = {},
): Promise<string> {
  assertEnabled(args.config);
  const transaction = decodeTransaction(args.transactionBase64);
  verifyAllSignatures(transaction);
  const connection = dependencies(overrides).createConnection(args);
  await verifyCluster(connection, args.config);
  const signature = await connection.sendRawTransaction(transactionBytes(transaction), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  if (signature !== bs58.encode(transaction.signatures[0])) throw unavailable('Preorder provider returned an unexpected signature.');
  return signature;
}

export async function probePreorderTransaction(
  args: ProviderArgs & {
    signature: string;
    transactionBase64: string;
    assets: PreorderAsset[];
    lastValidBlockHeight: number;
    blockhashContextSlot: number;
  },
  overrides: Partial<Dependencies> = {},
): Promise<{ status: 'confirmed' | 'failed' | 'expired' | 'pending'; slot?: number }> {
  assertEnabled(args.config);
  const transaction = decodeTransaction(args.transactionBase64);
  verifyAllSignatures(transaction);
  if (args.signature !== bs58.encode(transaction.signatures[0])) throw invalid('Stored preorder signature does not match its transaction.');
  const connection = dependencies(overrides).createConnection(args);
  await verifyCluster(connection, args.config);
  const finalized = await connection.getTransaction(args.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (finalized) {
    if (
      !finalized.meta ||
      !Buffer.from(finalized.transaction.message.serialize()).equals(Buffer.from(transaction.message.serialize())) ||
      finalized.transaction.signatures.length !== transaction.signatures.length ||
      finalized.transaction.signatures.some((signature, index) => signature !== bs58.encode(transaction.signatures[index]))
    ) throw unavailable('Finalized preorder transaction could not be verified.');
    return { status: finalized.meta.err === null ? 'confirmed' : 'failed', slot: finalized.slot };
  }
  const epoch = await connection.getEpochInfo('finalized');
  if (epoch.blockHeight === undefined || !Number.isSafeInteger(epoch.blockHeight) || !Number.isSafeInteger(epoch.absoluteSlot)) {
    throw unavailable('Preorder provider returned an invalid finalized height.');
  }
  if (epoch.blockHeight <= args.lastValidBlockHeight) return { status: 'pending' };
  const accounts = await connection.getMultipleAccountsInfoAndContext(args.assets.map((asset) => publicKey(asset.address, 'Asset')), {
    commitment: 'finalized', minContextSlot: epoch.absoluteSlot,
  });
  if (accounts.context.slot < epoch.absoluteSlot || accounts.value.length !== args.assets.length) {
    throw unavailable('Preorder provider returned stale account data.');
  }
  if (accounts.value.some((account) => account !== null && (
    account.executable || !account.owner.equals(SystemProgram.programId) || account.data.length !== 0
  ))) return { status: 'pending' };
  const history = await connection.getSignatureStatuses([args.signature], { searchTransactionHistory: true });
  if (history.context.slot < epoch.absoluteSlot || history.value.length !== 1) {
    throw unavailable('Preorder provider returned stale signature history.');
  }
  if (history.value[0]) return { status: 'pending' };
  const floors = await Promise.all([connection.getFirstAvailableBlock(), connection.getMinimumLedgerSlot()]);
  if (!Number.isSafeInteger(args.blockhashContextSlot) || args.blockhashContextSlot < 0 || floors.some((slot) => !Number.isSafeInteger(slot) || slot < 0)) {
    throw unavailable('Preorder provider returned invalid history coverage.');
  }
  if (floors.some((slot) => slot > args.blockhashContextSlot)) {
    const verified = await overrides.verifyArchivedAbsence?.({
      signature: args.signature, blockhashContextSlot: args.blockhashContextSlot,
      lastValidBlockHeight: args.lastValidBlockHeight, finalizedSlot: epoch.absoluteSlot,
    });
    if (verified !== true) return { status: 'pending' };
  }
  return { status: 'expired' };
}
