import { randomInt } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { DEPLOYMENT_DROPS } from '../../shared/deploymentRegistry.ts';
import { generateUniqueStripeReceiptClaimCodes } from '../../shared/stripeReceiptClaims.ts';
import { decodeBoxMinterConfigData } from '../../shared/boxMinterConfigCodec.ts';
import { BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses.ts';
import { bubblegumTreeConfigPda, decodeReceiptTreeState, validateReceiptPoolDeploymentOnchain } from '../deploy-all-onchain.ts';
import { assertReceiptPoolRpcGenesisHash } from '../deploy-receipt-pool.ts';
import { requireReceiptPoolSpec } from '../shared/receiptPoolConfig.ts';
import { createScriptSolanaConnection, resolveScriptSolanaRpcUrl } from '../shared/solanaRpcEnvironment.ts';
import { parsePrivateKeyInput, promptMaskedInput } from '../shared/interactive.ts';
import {
  BINDER_ISSUANCE_AUTHORITY, BINDER_ISSUANCE_COLLECTION, BINDER_ISSUANCE_ID, BINDER_ISSUANCE_RECEIPT_IDS,
  BINDER_ISSUANCE_TREE, binderReceiptMetadataUri, buildBinderReceiptMintTransaction, validateSignedBinderReceiptMint,
} from '../shared/binderReceiptIssuanceOnchain.ts';
import {
  preflightBinderReceiptIssuance, publishBinderReceiptIssuance,
  type BinderReceiptIssuancePlan, type BinderReceiptIssuanceReservation,
} from '../shared/binderReceiptIssuanceStore.ts';

type Journal = {
  version: 1;
  reservation: BinderReceiptIssuanceReservation;
  mint?: { blockhash: string; lastValidBlockHeight: number; transactionBase64: string; signature: string; finalizedSlot?: number };
  published?: boolean;
};

const DIRECTORY = path.join(homedir(), 'Library/Application Support/mons-shop/binder-receipt-issuance', BINDER_ISSUANCE_ID);
const JOURNAL_PATH = path.join(DIRECTORY, 'journal.json');
const OWNER = new PublicKey(BINDER_ISSUANCE_AUTHORITY);

function writePackingExport(plan: BinderReceiptIssuanceReservation): string {
  const packingPath = path.join(DIRECTORY, 'packing-codes.json');
  writeFileSync(packingPath, JSON.stringify({ orderId: `card_nft_binder:${plan.deliveryId}`, receipts: plan.receipts.map(receipt => ({
    receiptId: receipt.receiptId, claimCode: receipt.code, claimUrl: `https://mons.shop/claim/?code=${receipt.code}`, assetId: receipt.assetId,
  })) }, null, 2) + '\n', { mode: 0o600 });
  return packingPath;
}

function persist(journal: Journal): void {
  const temporary = `${JOURNAL_PATH}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(journal, null, 2) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, JOURNAL_PATH);
  const directory = openSync(DIRECTORY, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function loadJournal(): Journal {
  if (existsSync(JOURNAL_PATH)) {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as Journal;
    if (journal.version !== 1 || journal.reservation?.issuanceId !== BINDER_ISSUANCE_ID) throw new Error('Invalid issuance journal.');
    if (journal.mint) {
      const checked = validateSignedBinderReceiptMint(journal.mint.transactionBase64, journal.mint.blockhash);
      if (checked.signature !== journal.mint.signature || !Number.isSafeInteger(journal.mint.lastValidBlockHeight) ||
        journal.mint.lastValidBlockHeight < 1) throw new Error('Invalid journal transaction.');
    }
    return journal;
  }
  const codes = generateUniqueStripeReceiptClaimCodes(2);
  const journal: Journal = { version: 1, reservation: {
    issuanceId: BINDER_ISSUANCE_ID, deliveryId: randomInt(1, 0x7fff_ffff),
    receiptOwner: BINDER_ISSUANCE_AUTHORITY, createdAtMs: Date.now(),
    receipts: BINDER_ISSUANCE_RECEIPT_IDS.map((receiptId, index) => ({ receiptId, code: codes[index] })),
  } };
  persist(journal);
  return journal;
}

async function poolState(connection: Connection): Promise<number> {
  assertReceiptPoolRpcGenesisHash({ solanaCluster: 'mainnet-beta', genesisHash: await connection.getGenesisHash() });
  const drop = DEPLOYMENT_DROPS.card_nft_binder;
  if (drop.receiptMaxId !== 22 || drop.maxSupply !== 15 || !drop.forceSoldOut ||
    drop.collectionMint !== BINDER_ISSUANCE_COLLECTION || drop.receiptsMerkleTree !== BINDER_ISSUANCE_TREE) {
    throw new Error('Binder configuration must support exactly 22 receipts with sales closed.');
  }
  const treeKey = new PublicKey(BINDER_ISSUANCE_TREE);
  const [config, merkle, tree] = await connection.getMultipleAccountsInfo([
    new PublicKey(drop.boxMinterConfigPda), treeKey, bubblegumTreeConfigPda(treeKey),
  ], 'finalized');
  if (!config || config.owner.toBase58() !== drop.boxMinterProgramId || !merkle || !tree ||
    merkle.owner.toBase58() !== MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS || tree.owner.toBase58() !== BUBBLEGUM_PROGRAM_ADDRESS) {
    throw new Error('Unexpected on-chain binder account ownership.');
  }
  const minter = decodeBoxMinterConfigData(config.data);
  if (minter.maxSupply !== 15 || minter.minted !== 15 || new PublicKey(minter.admin).toBase58() !== BINDER_ISSUANCE_AUTHORITY) {
    throw new Error('Binder minter changed; review before issuing replacements.');
  }
  const state = decodeReceiptTreeState({ merkleTreeData: merkle.data, treeConfigData: tree.data });
  if (!state.creator.equals(OWNER) || !state.delegate.equals(OWNER) || state.isPublic || state.version !== 1 ||
    state.totalCapacity - state.numMinted < 2) throw new Error('Receipt pool authority or capacity changed.');
  const spec = requireReceiptPoolSpec('mons_shop_receipts');
  await validateReceiptPoolDeploymentOnchain({ connection, collectionMint: new PublicKey(BINDER_ISSUANCE_COLLECTION),
    receiptsMerkleTree: treeKey, authority: OWNER, collectionMetadataUri: spec.collectionMetadataUri,
    collectionName: spec.collectionName, royaltiesBasisPoints: spec.royaltiesBasisPoints,
    royaltiesRecipient: new PublicKey(spec.royaltiesRecipient), receiptsTreeMaxDepth: 14,
    receiptsTreeMaxBufferSize: 64, receiptsTreeCanopyDepth: 8, commitment: 'finalized' });
  return state.numMinted;
}

async function verifyMetadata(): Promise<void> {
  for (const id of BINDER_ISSUANCE_RECEIPT_IDS) {
    const response = await fetch(binderReceiptMetadataUri(id), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Receipt ${id} metadata returned HTTP ${response.status}.`);
    const data = await response.json() as Record<string, unknown>;
    if (data.id !== id || data.name !== `Binder Receipt #${id}` || data.description !== 'redeemed on mons dot shop' ||
      data.image !== 'https://cdn.lil.org/nft/card_nft_binder/receipt.png') throw new Error(`Receipt ${id} metadata mismatch.`);
  }
}

async function indexedReceipts(): Promise<Map<number, string>> {
  const response = await fetch(resolveScriptSolanaRpcUrl({ cluster: 'mainnet-beta' }), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetsByGroup', params: {
      groupKey: 'collection', groupValue: BINDER_ISSUANCE_COLLECTION, page: 1, limit: 1000,
    } }), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok || data.error || !Array.isArray(data.result?.items) || data.result.total > 1000) {
    throw new Error('Unable to verify the complete receipt collection index.');
  }
  const found = new Map<number, string>();
  for (const id of BINDER_ISSUANCE_RECEIPT_IDS) {
    const matches = data.result.items.filter((asset: { content?: { json_uri?: string } }) => asset.content?.json_uri === binderReceiptMetadataUri(id));
    if (matches.length > 1) throw new Error(`Duplicate receipt ${id} exists; manual review required.`);
    if (!matches.length) continue;
    const asset = matches[0];
    if (asset.burnt || asset.ownership?.owner !== BINDER_ISSUANCE_AUTHORITY || asset.compression?.tree !== BINDER_ISSUANCE_TREE ||
      !asset.grouping?.some((group: { group_key: string; group_value: string }) => group.group_key === 'collection' && group.group_value === BINDER_ISSUANCE_COLLECTION)) {
      throw new Error(`Receipt ${id} has unexpected ownership, collection or tree.`);
    }
    found.set(id, new PublicKey(asset.id).toBase58());
  }
  return found;
}

async function simulate(connection: Connection, blockhash: string): Promise<void> {
  const transaction = buildBinderReceiptMintTransaction(blockhash);
  const [simulation, balance, fee] = await Promise.all([
    connection.simulateTransaction(transaction, { sigVerify: false, commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [BINDER_ISSUANCE_AUTHORITY] } }),
    connection.getBalance(OWNER, 'confirmed'), connection.getFeeForMessage(transaction.message, 'confirmed'),
  ]);
  if (simulation.value.err) throw new Error(`Receipt mint simulation failed: ${JSON.stringify(simulation.value.err)}; ${(simulation.value.logs || []).join('\n')}`);
  console.log(JSON.stringify({ simulation: 'passed', cluster: 'mainnet-beta', receipts: [21, 22],
    recipient: BINDER_ISSUANCE_AUTHORITY, feePayer: BINDER_ISSUANCE_AUTHORITY,
    computeUnits: simulation.value.unitsConsumed, networkFeeLamports: fee.value,
    simulatedBalanceDecreaseLamports: balance - (simulation.value.accounts?.[0]?.lamports ?? balance),
    transactionBytes: transaction.serialize().length }));
}

async function sign(blockhash: string, signerUrl?: string): Promise<string> {
  if (signerUrl) {
    const url = new URL(signerUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw new Error('Signer URL must be a local Worker preview.');
    const token = process.env.BINDER_ISSUANCE_AUTH_TOKEN;
    if (!token) throw new Error('Missing private preview authorization token.');
    const response = await fetch(new URL('/sign', url), { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`,
    }, body: JSON.stringify({ blockhash }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Worker signer returned HTTP ${response.status}.`);
    const result = await response.json() as { transactionBase64?: string };
    if (!result.transactionBase64) throw new Error('Worker signer did not return a signed transaction.');
    return result.transactionBase64;
  }
  let signer: Keypair | undefined;
  try {
    signer = parsePrivateKeyInput(await promptMaskedInput('Binder pool authority private key (hidden): '));
    if (!signer.publicKey.equals(OWNER)) throw new Error('Signing key does not match the receipt pool authority.');
    const transaction = buildBinderReceiptMintTransaction(blockhash);
    transaction.sign([signer]);
    return Buffer.from(transaction.serialize()).toString('base64');
  } finally { signer?.secretKey.fill(0); }
}

async function settleMint(connection: Connection, journal: Journal): Promise<void> {
  const mint = journal.mint!;
  const status = (await connection.getSignatureStatuses([mint.signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) throw new Error('The saved transaction failed on-chain; inspect it before any replacement.');
  if (status?.confirmationStatus !== 'finalized') {
    if (!status && await connection.getBlockHeight('finalized') > mint.lastValidBlockHeight) {
      throw new Error('The saved transaction expired without a known result. No replacement will be signed automatically.');
    }
    if (!status) {
      const signature = await connection.sendRawTransaction(Buffer.from(mint.transactionBase64, 'base64'), {
        skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
      });
      if (signature !== mint.signature) throw new Error('RPC returned a different signature.');
      console.log(`Submitted receipt mint: ${signature}`);
    }
    const result = await connection.confirmTransaction({ signature: mint.signature, blockhash: mint.blockhash,
      lastValidBlockHeight: mint.lastValidBlockHeight }, 'finalized');
    if (result.value.err) throw new Error('Receipt mint transaction failed.');
  }
  const transaction = await connection.getTransaction(mint.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  const expected = validateSignedBinderReceiptMint(mint.transactionBase64, mint.blockhash).transaction;
  if (!transaction?.meta || transaction.meta.err ||
    !Buffer.from(transaction.transaction.message.serialize()).equals(Buffer.from(expected.message.serialize()))) {
    throw new Error('Finalized mint transaction could not be verified.');
  }
  mint.finalizedSlot = transaction.slot;
  persist(journal);
  console.log(JSON.stringify({ mint: 'finalized', signature: mint.signature, slot: mint.finalizedSlot, feeLamports: transaction.meta.fee }));
}

async function run(): Promise<void> {
  const flags = process.argv.slice(2);
  if (flags.includes('--help')) { console.log('npm run issue:binder-packing -- [--execute] [--signer-url http://127.0.0.1:8797]'); return; }
  let execute = false;
  let signerUrl: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--execute' && !execute) execute = true;
    else if (flags[index] === '--signer-url' && !signerUrl && flags[index + 1]) signerUrl = flags[++index];
    else throw new Error('Unknown issuance argument. Use --help.');
  }
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  const lock = path.join(DIRECTORY, 'active.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error(`Another issuance process may be running. Inspect ${lock} before retrying.`); }
  try {
    const journal = loadJournal();
    const preflight = await preflightBinderReceiptIssuance(journal.reservation);
    if (preflight.status === 'published') {
      journal.published = true;
      persist(journal);
      const packingPath = writePackingExport(journal.reservation);
      console.log(JSON.stringify({ status: 'published', deliveryId: journal.reservation.deliveryId, receipts: [21, 22], packingPath }));
      return;
    }
    const connection = createScriptSolanaConnection({ cluster: 'mainnet-beta' });
    const [minted] = await Promise.all([poolState(connection), verifyMetadata()]);
    if (!journal.mint) {
      if (minted !== 20 || (await indexedReceipts()).size !== 0) throw new Error('New receipts already exist or pool state changed; refusing another mint.');
      const block = await connection.getLatestBlockhash('confirmed');
      await simulate(connection, block.blockhash);
      console.log(JSON.stringify({ status: 'prepared', deliveryId: journal.reservation.deliveryId, receipts: [21, 22], journalPath: JOURNAL_PATH }));
      if (!execute) return;
      await preflightBinderReceiptIssuance(journal.reservation);
      const fresh = await connection.getLatestBlockhash('confirmed');
      await simulate(connection, fresh.blockhash);
      const transactionBase64 = await sign(fresh.blockhash, signerUrl);
      const { signature } = validateSignedBinderReceiptMint(transactionBase64, fresh.blockhash);
      journal.mint = { ...fresh, transactionBase64, signature };
      persist(journal);
    }
    if (!execute) { console.log(JSON.stringify({ status: 'signed', signature: journal.mint.signature })); return; }
    await settleMint(connection, journal);
    let found = await indexedReceipts();
    for (let attempt = 0; found.size !== 2 && attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      found = await indexedReceipts();
    }
    if (found.size !== 2) throw new Error('Mint finalized; indexing is pending. Rerun the same command to publish without reminting.');
    if (await poolState(connection) !== 22) throw new Error('Unexpected post-mint pool count.');
    const plan: BinderReceiptIssuancePlan = { ...journal.reservation, receipts: journal.reservation.receipts.map(receipt => ({
      ...receipt, assetId: found.get(receipt.receiptId)!, signature: journal.mint!.signature,
    })) };
    journal.reservation = plan;
    persist(journal);
    const publication = await publishBinderReceiptIssuance(plan);
    journal.published = true;
    persist(journal);
    const packingPath = writePackingExport(plan);
    console.log(JSON.stringify({ publication, deliveryId: plan.deliveryId, receipts: [21, 22], packingPath }));
  } finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error instanceof Error ? error.message : 'Binder receipt issuance failed.'); process.exitCode = 1; });
}
