import { createHash, createHmac, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { tsImport } from 'tsx/esm/api';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import { createScriptSolanaConnection, resolveScriptSolanaRpcUrl, scriptSolanaRpcHost } from './shared/solanaRpcEnvironment.ts';
import { verifyTwoConfigGateForDeployment } from './verify-two-config-programs.ts';
import { resolveStripeCheckoutEnabledForDropFamily } from '../shared/stripeCheckoutCore.ts';
import { readMintActivationJournal, type ActivationJournal } from './shared/mintActivationJournal.ts';
import type { DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import type { MiNoteDropManifest } from './shared/miNoteDropManifest.ts';
import type { CommerceAuthorityQuery } from './shared/commerceD1Maintenance.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DROP_ID = 'mi_note_cards_devnet';
const PROGRAM = '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6';
const COLLECTION = '65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv';
const AUTHORITY = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FUNDING = 500_000_000;
const PRICE = 250_000_000;
const DEFAULT_FUNDING = 350_000_000;
const MINT_RECIPIENTS = ['BmV4TRHUfMZcaa6iZA4tSGf6ACGoLLsYEHcC55AEKAYf', '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM'];

type PendingTransaction = {
  label: string;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  status: 'pending' | 'finalized' | 'failed';
  simulationUnits: number;
  feeLamports: number;
};

export type MiNoteSmokeRecord = {
  version: 1;
  runId: string;
  cluster: 'devnet';
  dropId: typeof DROP_ID;
  authority: string;
  buyer: string;
  collection: string;
  mintConfig: string;
  operationsConfig: string;
  metadataBase: string;
  manifestSha256: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
  status: 'prepared' | 'preflight-failed' | 'running' | 'passed' | 'cancelled' | 'recovery-required' | 'recovered';
  stage: string;
  fundingLamports: number;
  knownAssets: string[];
  transactions: PendingTransaction[];
  pack?: { address: string; id?: number; pending: string; cards: string[] };
  reveal?: { signature: string; ids: number[] };
  receipts?: { signature: string; tree: string; uris: string[]; recipient: string };
  preorderBefore?: { count: number; sha256: string };
  preorderAfter?: { count: number; sha256: string };
  cleanup?: { buyerLamports: number; buyerOwnedAssets: string[]; unexpectedOwners: string[]; pendingOpen: boolean };
  diagnostic?: { stage: string; message: string; at: string };
  missingPreflightRecord?: boolean;
  activationSignature?: string;
  shippingOrderCreated: false;
};

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function validateOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.origin !== raw || url.protocol !== 'https:' ||
    !['mons.shop', 'www.mons.shop', 'candidate-mons-shop.lil-org.workers.dev'].includes(url.hostname)) {
    throw new Error('Smoke API origin must be an approved HTTPS mons.shop frontend.');
  }
  return url.origin;
}

export function parseMiNoteSmokeArgs(argv: string[]) {
  let origin = 'https://mons.shop';
  let rpcUrl: string | undefined;
  let manifestPath = path.join(ROOT, 'releases/mi-note-cards-devnet/inventory.json');
  let recoverRunId: string | undefined;
  let check = false;
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check' && !check) { check = true; continue; }
    if (flag === '--yes' && !yes) { yes = true; continue; }
    const value = argv[++index];
    if (!value) throw new Error('Expected --origin, --rpc-url, --manifest, or --recover with a value.');
    if (flag === '--origin') origin = validateOrigin(value);
    else if (flag === '--rpc-url') {
      if (new URL(value).protocol !== 'https:') throw new Error('Smoke RPC must use HTTPS.');
      rpcUrl = value;
    } else if (flag === '--manifest') manifestPath = path.resolve(value);
    else if (flag === '--recover' && UUID.test(value)) recoverRunId = value;
    else throw new Error(`Unsupported smoke argument: ${flag}`);
  }
  if (check && recoverRunId) throw new Error('Use --check separately from --recover.');
  return { origin, rpcUrl, manifestPath, recoverRunId, check, yes };
}

export function redactMiNoteSmokeError(error: unknown, rpcUrl?: string): string {
  let message = error instanceof Error ? error.message : 'Unknown smoke failure.';
  if (rpcUrl) {
    try {
      const endpoint = new URL(rpcUrl);
      for (const secret of [endpoint.username, endpoint.password, ...[...endpoint.searchParams]
        .filter(([name]) => /key|token|auth|secret|password/i.test(name)).map(([, value]) => value)]) {
        if (secret) message = message.split(secret).join('[redacted]');
      }
    } catch { }
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => scriptSolanaRpcHost(url))
    .replace(/mons_(?:anon|staff)_v1\.[A-Za-z0-9_.-]+/g, '[redacted session]').slice(0, 1500);
}

export function acquireMiNoteSmokeRunLock(file: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch { throw new Error(`Smoke run is already locked: ${lock}. Do not run concurrent recoveries; remove a stale lock only after its process has exited.`); }
  const ownership = `${JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() })}\n`;
  writeFileSync(descriptor, ownership);
  closeSync(descriptor);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try { if (readFileSync(lock, 'utf8') === ownership) unlinkSync(lock); } catch { }
  };
  process.once('exit', release);
  return release;
}

export function isNeverFundedMiNoteSmokeRecord(record: MiNoteSmokeRecord): boolean {
  return ['prepared', 'preflight-failed', 'running', 'cancelled', 'recovery-required'].includes(record.status) &&
    record.transactions.length === 0 && record.knownAssets.length === 0 && !record.pack && !record.reveal && !record.receipts;
}

export async function proveMiNoteSmokeBuyerUnused(connection: Pick<Connection,
  'getAccountInfo' | 'getBalance' | 'getSignaturesForAddress'>, buyer: PublicKey): Promise<void> {
  for (const commitment of ['finalized', 'confirmed'] as const) {
    const [account, balance, signatures] = await Promise.all([
      connection.getAccountInfo(buyer, commitment), connection.getBalance(buyer, commitment),
      connection.getSignaturesForAddress(buyer, { limit: 1 }, commitment),
    ]);
    if (account !== null || balance !== 0 || signatures.length !== 0) {
      throw new Error('Buyer already has an account, SOL, or transaction history; refusing a fresh purchase during recovery.');
    }
  }
}

export function requireMiNoteSmokeActivationAnchor(journal: ActivationJournal, runId: string): string {
  const attempt = [...journal.attempts].reverse().find((entry) => entry.status === 'finalized' || entry.status === 'state-verified');
  if (journal.status !== 'active' || journal.authority !== AUTHORITY || journal.dropId !== DROP_ID || journal.cluster !== 'devnet' ||
    journal.smoke?.runId !== runId || journal.smoke.status !== 'recovery-required' || !attempt || !journal.activeState) {
    throw new Error('Missing smoke record is not anchored to the active authority-signed activation journal and this exact run ID.');
  }
  return attempt.signature;
}

export function deriveMiNoteSmokeBuyer(authority: Keypair, runId: string): { buyer: Keypair; destroy: () => void } {
  if (!UUID.test(runId)) throw new Error('Invalid smoke run ID.');
  const authorityBytes = authority.secretKey;
  const seed = createHmac('sha256', authorityBytes)
    .update(`mons.shop:smoke-buyer:v1\0devnet\0${DROP_ID}\0${runId}`).digest();
  authorityBytes.fill(0);
  const generated = nacl.sign.keyPair.fromSeed(seed);
  seed.fill(0);
  const buyer = Keypair.fromSecretKey(generated.secretKey);
  return { buyer, destroy: () => generated.secretKey.fill(0) };
}

export function validateMiNoteSmokeDrop(drop: DeploymentRegistryDrop, manifest: MiNoteDropManifest): void {
  if (drop.dropId !== DROP_ID || drop.solanaCluster !== 'devnet' || drop.boxMinterProgramId !== PROGRAM ||
    drop.collectionMint !== COLLECTION || drop.itemsPerBox !== 2 || drop.maxSupply !== 704 ||
    drop.priceSol !== 0.25 || drop.discountPriceSol !== 0.25 || drop.discountMerkleRoot !== hash(Buffer.alloc(32)) ||
    resolveStripeCheckoutEnabledForDropFamily(drop.stripeCheckoutEnabled, drop.dropFamily).enabled || !drop.operationsConfig ||
    drop.paymentRouting?.mintProceeds.length !== 2 || drop.paymentRouting.deliveryPaymentReceiver !== AUTHORITY ||
    drop.paymentRouting.mintProceeds.some((recipient, index) => recipient.address !== MINT_RECIPIENTS[index] || recipient.percentage !== 50) ||
    drop.operationsConfig.configId !== `${DROP_ID}_operations` || drop.operationsConfig.maxSupply !== 715 ||
    !drop.boxMinterConfigPda || drop.boxMinterConfigPda === drop.operationsConfig.boxMinterConfigPda ||
    manifest.sourcePreorder.preorderId !== DROP_ID || manifest.sourcePreorder.cluster !== 'devnet' ||
    manifest.sourcePreorder.collection !== COLLECTION || manifest.packCount !== 704 || manifest.maxFigureId !== 1430 ||
    manifest.excludedCardIds.length !== 22 || manifest.eligibleCardIds.length !== 1408 ||
    drop.metadataBase !== manifest.metadataBase || drop.inventoryManifest?.sha256 !== manifest.sha256 ||
    JSON.stringify(drop.inventoryManifest.cardIds) !== JSON.stringify(manifest.eligibleCardIds)) {
    throw new Error('Smoke requires the reviewed Mi Note devnet two-config deployment and its unchanged 22 preorder exclusions.');
  }
}

export function assertMiNoteSmokeReveal(value: unknown, manifest: MiNoteDropManifest): { signature: string; ids: number[] } {
  const raw = value as { signature?: unknown; dudeIds?: unknown };
  if (!raw || typeof raw.signature !== 'string' || !Array.isArray(raw.dudeIds) || raw.dudeIds.length !== 2 ||
    raw.dudeIds.some((id) => !Number.isSafeInteger(id) || !manifest.eligibleCardIds.includes(id) || manifest.excludedCardIds.includes(id)) ||
    new Set(raw.dudeIds).size !== 2) throw new Error('Reveal did not return two distinct eligible non-preorder cards.');
  const signature = bs58.decode(raw.signature);
  if (signature.length !== 64 || !signature.some((byte) => byte !== 0)) throw new Error('Invalid reveal signature.');
  return { signature: raw.signature, ids: [...raw.dudeIds] };
}

class SmokeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Smoke API request failed (${status}, ${code}).`);
    this.status = status;
    this.code = code;
  }
}

export class MiNoteSmokeApi {
  #cookie = '';
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  constructor(origin: string, fetchImpl: typeof fetch = fetch) {
    validateOrigin(origin);
    this.origin = origin;
    this.fetchImpl = fetchImpl;
  }

  async call(endpoint: string, body: object): Promise<unknown> {
    if (!['/auth/anonymous/session', '/auth/anonymous/logout', '/auth/solana', '/boxes/reveal'].includes(endpoint)) {
      throw new Error('Smoke API path is not permitted.');
    }
    const response = await this.fetchImpl(`${this.origin}/api${endpoint}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Mons-CSRF': '1', Origin: this.origin,
        ...(this.#cookie ? { Cookie: this.#cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie?.startsWith('__Host-mons_anon_v1=')) this.#cookie = cookie.split(';', 1)[0];
    const text = await response.text();
    if (text.length > 65_536) throw new Error('Smoke API response is too large.');
    let value: any;
    try { value = JSON.parse(text); } catch { throw new SmokeApiError(response.status, 'invalid-response'); }
    if (!response.ok) throw new SmokeApiError(response.status, typeof value?.error?.code === 'string' ? value.error.code : 'unavailable');
    return value;
  }

  async authenticate(buyer: Keypair): Promise<void> {
    const session = await this.call('/auth/anonymous/session', {}) as { subject?: unknown };
    if (typeof session.subject !== 'string' || !/^anon:[0-9a-f-]{36}$/.test(session.subject) ||
      !/^__Host-mons_anon_v1=mons_anon_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(this.#cookie)) {
      throw new Error('Anonymous authentication returned an invalid session.');
    }
    const message = `Sign in to mons.shop as ${buyer.publicKey.toBase58()}\nDomain: ${new URL(this.origin).hostname}\nTimestamp: ${new Date().toISOString()}\nSession: ${session.subject}`;
    const bytes = buyer.secretKey;
    const signature = nacl.sign.detached(Buffer.from(message), bytes);
    bytes.fill(0);
    const result = await this.call('/auth/solana', { wallet: buyer.publicKey.toBase58(), message, signature: Array.from(signature) }) as { wallet?: string };
    if (result.wallet !== buyer.publicKey.toBase58()) throw new Error('Smoke session is bound to another wallet.');
  }

  async probeReveal(owner: string): Promise<void> {
    try { await this.call('/boxes/reveal', { owner, boxAssetId: owner, dropId: DROP_ID }); }
    catch (error) {
      if (error instanceof SmokeApiError && error.code === 'not-found') return;
      throw error;
    }
    throw new Error('Unexpected pending open for the new smoke buyer.');
  }

  async logout(): Promise<void> {
    if (!this.#cookie) return;
    try { await this.call('/auth/anonymous/logout', {}); } finally { this.#cookie = ''; }
  }
}

function saveRecord(file: string, record: MiNoteSmokeRecord): void {
  record.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const descriptor = openSync(temporary, 'w');
  try { writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function waitFinalized(connection: Connection, transaction: PendingTransaction): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) { transaction.status = 'failed'; throw new Error(`Smoke transaction failed: ${transaction.label}`); }
    if (status?.confirmationStatus === 'finalized') { transaction.status = 'finalized'; return; }
    if (!status && transaction.lastValidBlockHeight > 0 &&
      await connection.getBlockHeight('finalized') > transaction.lastValidBlockHeight) {
      transaction.status = 'failed';
      throw new Error(`Smoke transaction expired without landing: ${transaction.label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Smoke transaction remains unresolved: ${transaction.label}`);
}

export async function submitMiNoteSmokeTransaction(args: {
  connection: Connection;
  transaction: VersionedTransaction;
  signers: Keypair[];
  label: string;
  record: MiNoteSmokeRecord;
  persist: () => void;
  approved: boolean;
}): Promise<string> {
  if (args.approved !== true || args.record.cluster !== 'devnet' || await args.connection.getGenesisHash() !== GENESIS) {
    throw new Error('Smoke transaction requires approval and verified devnet RPC.');
  }
  const latest = await args.connection.getLatestBlockhash('confirmed');
  args.transaction.message.recentBlockhash = latest.blockhash;
  args.transaction.sign(args.signers);
  const simulated = await args.connection.simulateTransaction(args.transaction, { sigVerify: true, commitment: 'confirmed' });
  if (simulated.value.err) throw new Error(`Smoke simulation failed: ${args.label}`);
  const fee = (await args.connection.getFeeForMessage(args.transaction.message, 'confirmed')).value;
  if (!Number.isSafeInteger(fee) || fee === null || fee < 0 || fee > 100_000) throw new Error('Smoke transaction fee exceeds its bound.');
  const pending: PendingTransaction = {
    label: args.label, signature: bs58.encode(args.transaction.signatures[0]), blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight, status: 'pending',
    simulationUnits: simulated.value.unitsConsumed ?? 0, feeLamports: fee,
  };
  args.record.transactions.push(pending);
  args.persist();
  try {
    try {
      const signature = await args.connection.sendRawTransaction(args.transaction.serialize(), { skipPreflight: false, maxRetries: 0 });
      if (signature !== pending.signature) throw new Error('Smoke RPC returned an unexpected signature.');
    } catch {
      await waitFinalized(args.connection, pending);
    }
    if (pending.status === 'pending') await waitFinalized(args.connection, pending);
  } finally { args.persist(); }
  return pending.signature;
}

function transaction(payer: PublicKey, instructions: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions],
  }).compileToV0Message());
}

async function loadModules() {
  const [registry, manifest, minter, core, projection, receipts, commerce, preorderIdentity] = await Promise.all([
    tsImport('./shared/deploymentRegistry.ts', import.meta.url) as Promise<typeof import('./shared/deploymentRegistry.ts')>,
    tsImport('./shared/miNoteDropManifest.ts', import.meta.url) as Promise<typeof import('./shared/miNoteDropManifest.ts')>,
    tsImport('../src/lib/boxMinter.ts', import.meta.url) as Promise<typeof import('../src/lib/boxMinter.ts')>,
    tsImport('../cloud/workers/api/src/preorderTransaction.ts', import.meta.url) as Promise<typeof import('../cloud/workers/api/src/preorderTransaction.ts')>,
    tsImport('../shared/deploymentProjection.ts', import.meta.url) as Promise<typeof import('../shared/deploymentProjection.ts')>,
    tsImport('../cloud/workers/api/src/deliveryReceiptOnchain.ts', import.meta.url) as Promise<{
      mintReceiptsInstruction: (args: object) => TransactionInstruction;
      closeDeliveryInstruction: (args: object) => TransactionInstruction;
    }>,
    tsImport('./shared/commerceD1Maintenance.ts', import.meta.url) as Promise<typeof import('./shared/commerceD1Maintenance.ts')>,
    tsImport('../shared/preorderAssetIdentity.ts', import.meta.url) as Promise<typeof import('../shared/preorderAssetIdentity.ts')>,
  ]);
  return { registry, manifest, minter, core, projection, receipts, commerce, preorderIdentity };
}

export async function readMiNoteSmokePreorderFingerprint(
  connection: Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfoAndContext'>,
  drop: DeploymentRegistryDrop,
  manifest: MiNoteDropManifest,
  overrides: { query?: CommerceAuthorityQuery; catalogText?: string } = {},
) {
  const modules = await loadModules();
  modules.manifest.parseMiNoteDropManifest(manifest);
  const config = modules.manifest.closedMiNotePreorderConfig(manifest.sourcePreorder.preorderId);
  if (drop.dropId !== config.preorderId || drop.solanaCluster !== config.cluster || drop.collectionMint !== config.collection ||
    drop.maxSupply !== manifest.packCount || drop.inventoryManifest?.sha256 !== manifest.sha256 ||
    JSON.stringify(drop.inventoryManifest.cardIds) !== JSON.stringify(manifest.eligibleCardIds) ||
    await connection.getGenesisHash() !== modules.manifest.MI_NOTE_CLUSTER_GENESIS[manifest.sourcePreorder.cluster]) {
    throw new Error('Smoke preorder audit has an unexpected drop or RPC cluster.');
  }
  const query = overrides.query ?? modules.commerce.queryRemoteCommerceD1;
  const catalogText = overrides.catalogText ?? readFileSync(path.join(ROOT, 'mi_note_cards.json'), 'utf8');
  if (modules.manifest.miNoteManifestDigest(catalogText) !== manifest.catalogSha256) throw new Error('Smoke catalog changed.');
  const catalog = modules.manifest.miNoteCatalogIds(catalogText);
  const snapshot = await modules.manifest.readMiNotePreorderSnapshot(query, config);
  const validated = modules.manifest.validateMiNotePreorderSnapshot(snapshot, config, catalog.preorder);
  const snapshotHash = modules.manifest.miNoteManifestDigest(snapshot);
  const excluded = new Set(validated.excludedIds);
  if (snapshotHash !== manifest.preorderSnapshotSha256 ||
    JSON.stringify(validated.excludedIds) !== JSON.stringify(manifest.excludedCardIds) ||
    JSON.stringify(catalog.all.filter((id) => !excluded.has(id))) !== JSON.stringify(manifest.eligibleCardIds)) {
    throw new Error('Smoke preorder exclusions changed.');
  }
  const fingerprints: [number, string, string][] = [];
  let slot = manifest.chain.slot;
  for (let offset = 0; offset < validated.assets.length; offset += 100) {
    const batch = validated.assets.slice(offset, offset + 100);
    const result = await connection.getMultipleAccountsInfoAndContext(batch.map(({ address }) => new PublicKey(address)), {
      commitment: 'finalized', minContextSlot: slot,
    });
    if (!Number.isSafeInteger(result.context.slot) || result.context.slot < slot || result.value.length !== batch.length) {
      throw new Error('Smoke preorder direct reads are stale or incomplete.');
    }
    slot = result.context.slot;
    for (const [index, expected] of batch.entries()) {
      const account = result.value[index];
      const asset = account && modules.core.decodePreorderAssetAccount(account.data);
      if (!account || account.executable || !account.owner.equals(CORE) || !asset ||
        !modules.preorderIdentity.resolveClaimedPreorderAsset({ config, cluster: config.cluster, claim: expected,
          actual: { ...asset, address: expected.address }, publicDrop: drop })) {
        throw new Error('A claimed preorder account is missing, changed, or invalid during smoke.');
      }
      fingerprints.push([expected.id, expected.address, hash(account.data)]);
    }
  }
  const fresh = await modules.manifest.readMiNotePreorderSnapshot(query, config);
  if (modules.manifest.miNoteManifestDigest(fresh) !== snapshotHash) throw new Error('Preorder source changed during smoke fingerprinting.');
  return { count: fingerprints.length, sha256: hash(JSON.stringify(fingerprints)) };
}

export function calculateMiNoteSmokeFunding(assetRent: number, pendingRent: number): number {
  if (![assetRent, pendingRent].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid smoke rent estimate.');
  const funding = Math.max(DEFAULT_FUNDING, PRICE + 3 * assetRent + pendingRent + 20_000_000);
  if (!Number.isSafeInteger(funding) || funding > MAX_FUNDING) throw new Error('Estimated smoke funding exceeds 0.5 devnet SOL.');
  return funding;
}

function coreTransfer(asset: PublicKey, buyer: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: CORE, keys: [
    { pubkey: asset, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(COLLECTION), isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: buyer, isSigner: true, isWritable: false },
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: NOOP, isSigner: false, isWritable: false },
  ], data: Buffer.from([14, 0]) });
}

export async function verifyReceiptMint(connection: Connection, signature: string, authority: PublicKey, expectedUris: string[]): Promise<void> {
  let result: Awaited<ReturnType<Connection['getTransaction']>> = null;
  for (let attempt = 0; attempt < 6 && !result; attempt += 1) {
    result = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!result && attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  if (!result?.meta || result.meta.err) throw new Error('Receipt mint transaction is not finalized successfully.');
  const accounts = result.transaction.message.getAccountKeys({ accountKeysFromLookups: result.meta.loadedAddresses });
  const uris: string[] = [];
  for (const group of result.meta.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (!accounts.get(instruction.programIdIndex)?.equals(BUBBLEGUM)) continue;
      const bytes = Buffer.from(bs58.decode(instruction.data));
      if (!bytes.subarray(0, 8).equals(Buffer.from([120, 121, 23, 146, 173, 110, 199, 205]))) continue;
      if (!accounts.get(instruction.accounts[4])?.equals(authority) || !accounts.get(instruction.accounts[5])?.equals(authority) ||
        accounts.get(instruction.accounts[7])?.toBase58() !== COLLECTION) throw new Error('Receipt CPI has unexpected ownership or collection.');
      let offset = 8;
      const read = () => {
        const length = bytes.readUInt32LE(offset); offset += 4;
        if (length > 2048 || offset + length > bytes.length) throw new Error('Invalid receipt metadata.');
        const text = bytes.subarray(offset, offset + length).toString('utf8'); offset += length;
        return text;
      };
      read(); read(); uris.push(read());
    }
  }
  if (JSON.stringify(uris.sort()) !== JSON.stringify([...expectedUris].sort())) throw new Error('Receipt mint metadata does not match smoke assets.');
}

async function prepareMiNoteSmokePreflight(args: {
  connection: Connection; rpcUrl: string; manifestPath?: string; onStage?: (stage: string) => void;
}) {
  const step = (stage: string) => args.onStage?.(`preflight-${stage}`);
  step('modules');
  const modules = await loadModules();
  step('cluster');
  if (await args.connection.getGenesisHash() !== GENESIS) throw new Error('Smoke refuses non-devnet RPC.');
  step('registry-and-manifest');
  const registry = await modules.registry.readDeploymentDropRegistry(path.join(ROOT, 'shared/deploymentRegistry.ts'));
  const drop = registry.drops[DROP_ID];
  if (!drop) throw new Error('Deploy Mi Note devnet before running the smoke tool.');
  const manifest = modules.manifest.parseMiNoteDropManifest(JSON.parse(readFileSync(args.manifestPath ?? path.join(ROOT, 'releases/mi-note-cards-devnet/inventory.json'), 'utf8')));
  validateMiNoteSmokeDrop(drop, manifest);
  step('program-gate');
  await verifyTwoConfigGateForDeployment({ cluster: 'devnet', rpcUrl: args.rpcUrl });
  const projected = modules.projection.projectDeploymentDropCore(drop);
  step('mint-config-A');
  const mint = await modules.minter.fetchBoxMinterConfig(args.connection, projected, 'mint');
  step('operations-config-B');
  const operations = await modules.minter.fetchBoxMinterConfig(args.connection, projected, 'operations');
  if (!mint.started || mint.minted >= mint.maxSupply || mint.priceLamports !== BigInt(PRICE) || mint.discountPriceLamports !== BigInt(PRICE) ||
    Buffer.from(mint.discountMerkleRoot).toString('hex') !== drop.discountMerkleRoot ||
    Buffer.from(operations.discountMerkleRoot).toString('hex') !== drop.discountMerkleRoot ||
    mint.admin.toBase58() !== AUTHORITY || operations.admin.toBase58() !== AUTHORITY) {
    throw new Error('Smoke requires activated A with supply available and the expected devnet authority/price.');
  }
  step('preorders');
  const preorderBefore = await readMiNoteSmokePreorderFingerprint(args.connection, drop, manifest);
  step('funding-budget');
  const fundingLamports = calculateMiNoteSmokeFunding(
    await args.connection.getMinimumBalanceForRentExemption(512), await args.connection.getMinimumBalanceForRentExemption(181),
  );
  const authorityBalanceLamports = await args.connection.getBalance(new PublicKey(AUTHORITY), 'finalized');
  if (authorityBalanceLamports < fundingLamports + 50_000_000) {
    throw new Error('Authority needs bounded buyer funding plus 0.05 devnet SOL for smoke administration.');
  }
  return { modules, drop, manifest, projected, mint, operations, preorderBefore, fundingLamports, authorityBalanceLamports };
}

export async function checkMiNoteDevnetSmoke(options: { rpcUrl?: string; manifestPath?: string } = {}) {
  const rpcUrl = resolveScriptSolanaRpcUrl({ cluster: 'devnet', root: ROOT, explicitUrl: options.rpcUrl || process.env.TWO_CONFIG_DEVNET_RPC_URL });
  const connection = createScriptSolanaConnection({ cluster: 'devnet', root: ROOT, explicitUrl: rpcUrl });
  let stage = 'preflight';
  try {
    const state = await prepareMiNoteSmokePreflight({ connection, rpcUrl, manifestPath: options.manifestPath, onStage: (value) => { stage = value; } });
    stage = 'preflight-unsigned-funding-simulation';
    const funding = transaction(new PublicKey(AUTHORITY), [SystemProgram.transfer({
      fromPubkey: new PublicKey(AUTHORITY), toPubkey: new PublicKey(createHash('sha256').update(`readonly-smoke:${randomUUID()}`).digest()),
      lamports: state.fundingLamports,
    })]);
    funding.message.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const simulation = await connection.simulateTransaction(funding, { commitment: 'confirmed', sigVerify: false });
    if (simulation.value.err) throw new Error(`Unsigned funding simulation failed: ${JSON.stringify(simulation.value.err)}`);
    return { ready: true, readOnly: true, cluster: 'devnet', dropId: DROP_ID, rpcHost: scriptSolanaRpcHost(rpcUrl),
      mint: { address: state.mint.pubkey.toBase58(), started: state.mint.started, minted: state.mint.minted, supply: state.mint.maxSupply },
      operations: { address: state.operations.pubkey.toBase58(), started: state.operations.started, minted: state.operations.minted },
      manifestSha256: state.manifest.sha256, preorders: state.preorderBefore, fundingLamports: state.fundingLamports,
      authorityBalanceLamports: state.authorityBalanceLamports, unsignedFundingSimulationUnits: simulation.value.unitsConsumed ?? 0 };
  } catch (error) { throw new Error(`Smoke preflight failed at ${stage}: ${redactMiNoteSmokeError(error, rpcUrl)}`); }
}

export type MiNoteDevnetSmokeOptions = {
  authority: Keypair;
  origin?: string;
  rpcUrl?: string;
  manifestPath?: string;
  recoverRunId?: string;
  yes?: boolean;
  recordDirectory?: string;
  confirm?: (summary: string) => Promise<boolean>;
};

export async function runMiNoteDevnetSmoke(options: MiNoteDevnetSmokeOptions): Promise<MiNoteSmokeRecord> {
  if (options.authority.publicKey.toBase58() !== AUTHORITY) throw new Error('Smoke requires the existing Mi Note devnet authority.');
  if (options.recoverRunId && !UUID.test(options.recoverRunId)) throw new Error('Invalid recovery run ID.');
  const runId = options.recoverRunId ?? randomUUID();
  const file = path.join(options.recordDirectory ?? path.join(ROOT, 'releases/mi-note-cards-devnet/smoke'), `${runId}.json`);
  const release = acquireMiNoteSmokeRunLock(file);
  try { return await runMiNoteDevnetSmokeLocked(options, runId, file); } finally { release(); }
}

async function runMiNoteDevnetSmokeLocked(options: MiNoteDevnetSmokeOptions, runId: string, file: string): Promise<MiNoteSmokeRecord> {
  const missingRecord = Boolean(options.recoverRunId && !existsSync(file));
  const existing = options.recoverRunId && !missingRecord ? JSON.parse(readFileSync(file, 'utf8')) as MiNoteSmokeRecord : undefined;
  if (options.recoverRunId && !missingRecord && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error('Invalid public smoke recovery record; existing file was not modified.');
  }
  const origin = validateOrigin(options.origin ?? existing?.origin ?? 'https://mons.shop');
  const rpcUrl = resolveScriptSolanaRpcUrl({
    cluster: 'devnet', root: ROOT, explicitUrl: options.rpcUrl || process.env.TWO_CONFIG_DEVNET_RPC_URL,
  });
  const connection = createScriptSolanaConnection({ cluster: 'devnet', root: ROOT, explicitUrl: rpcUrl });
  let modules: Awaited<ReturnType<typeof loadModules>>;
  const derived = deriveMiNoteSmokeBuyer(options.authority, runId);
  const buyer = derived.buyer;
  const authority = options.authority;
  const api = new MiNoteSmokeApi(origin);
  let approved = false;
  let completed = false;
  let performedFullSmoke = false;
  let failure: unknown;
  let auditedDrop: DeploymentRegistryDrop | undefined;
  let auditedManifest: MiNoteDropManifest | undefined;
  const record: MiNoteSmokeRecord = existing ?? {
    version: 1, runId, cluster: 'devnet', dropId: DROP_ID, authority: authority.publicKey.toBase58(),
    buyer: buyer.publicKey.toBase58(), collection: COLLECTION, mintConfig: '', operationsConfig: '', metadataBase: '',
    manifestSha256: '', origin, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'prepared', stage: 'preflight', fundingLamports: 0, knownAssets: [], transactions: [], shippingOrderCreated: false,
    ...(missingRecord ? { missingPreflightRecord: true } : {}),
  };
  if (existing && (existing.version !== 1 || existing.runId !== runId || existing.cluster !== 'devnet' ||
    existing.dropId !== DROP_ID || existing.authority !== authority.publicKey.toBase58() || existing.buyer !== buyer.publicKey.toBase58() ||
    existing.collection !== COLLECTION || !Array.isArray(existing.knownAssets) || existing.knownAssets.length > 3 ||
    !Array.isArray(existing.transactions))) {
    derived.destroy();
    throw new Error('Invalid public smoke recovery identity; existing file was not modified.');
  }
  const persist = () => saveRecord(file, record);
  const submit = (label: string, tx: VersionedTransaction, signers: Keypair[]) => submitMiNoteSmokeTransaction({
    connection, transaction: tx, signers, label, record, persist, approved,
  });
  const stage = (value: string) => { record.stage = value; persist(); console.log(`Smoke ${runId}: ${value}`); };
  const confirm = options.confirm ?? (async (summary: string) => {
    console.log(summary);
    return options.yes ? true : promptYConfirmation('Run this controlled devnet smoke test? [y/N] ');
  });
  const reveal = async (manifest: MiNoteDropManifest) => {
    if (!record.pack) throw new Error('Smoke pack is not recorded.');
    stage('live-api-reveal');
    let response: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await api.call('/boxes/reveal', { owner: buyer.publicKey.toBase58(), boxAssetId: record.pack.address, dropId: DROP_ID });
        break;
      } catch (error) {
        if (error instanceof SmokeApiError && error.status < 500 && error.code !== 'reveal-submission-unknown') throw error;
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    record.reveal = assertMiNoteSmokeReveal(response, manifest);
    persist();
    const responseStatus: PendingTransaction = { label: 'API reveal', signature: record.reveal.signature,
      blockhash: '', lastValidBlockHeight: 0, status: 'pending', simulationUnits: 0, feeLamports: 0 };
    await waitFinalized(connection, responseStatus);
  };

  try {
    persist();
    stage('preflight-modules');
    modules = await loadModules();
    stage('preflight-cluster');
    if (await connection.getGenesisHash() !== GENESIS) throw new Error('Smoke refuses non-devnet RPC.');
    const resumeUnfunded = Boolean(options.recoverRunId && isNeverFundedMiNoteSmokeRecord(record));
    if (resumeUnfunded) {
      stage('preflight-unused-buyer');
      await proveMiNoteSmokeBuyerUnused(connection, buyer.publicKey);
    }
    if (existing && !resumeUnfunded) {
      approved = await confirm(`Recover devnet smoke ${runId}\nBuyer: ${buyer.publicKey.toBase58()}\nReturn its recorded assets and remaining SOL to ${AUTHORITY}. No new purchase, funding, delivery or receipts.`) === true;
      if (!approved) return record;
      stage('recovery');
      for (const pending of record.transactions.filter(({ status }) => status === 'pending')) {
        try { await waitFinalized(connection, pending); } catch { }
      }
      const pending = record.pack ? await connection.getAccountInfo(new PublicKey(record.pack.pending), 'finalized') : null;
      if (pending) {
        const manifest = modules.manifest.parseMiNoteDropManifest(JSON.parse(readFileSync(options.manifestPath ?? path.join(ROOT, 'releases/mi-note-cards-devnet/inventory.json'), 'utf8')));
        if (manifest.sha256 !== record.manifestSha256) throw new Error('Recovery manifest does not match the smoke record.');
        await api.authenticate(buyer);
        await reveal(manifest);
      }
      completed = true;
    } else {
      performedFullSmoke = true;
      const prepared = await prepareMiNoteSmokePreflight({ connection, rpcUrl, manifestPath: options.manifestPath, onStage: stage });
      const { drop, manifest, projected, mint, operations } = prepared;
      auditedDrop = drop;
      auditedManifest = manifest;
      if (record.missingPreflightRecord) {
        stage('preflight-activation-anchor');
        const { journal } = readMintActivationJournal(path.join(ROOT, 'releases/mi-note-cards-devnet/activation.json'), {
          dropId: DROP_ID, cluster: 'devnet', programId: PROGRAM, authority: AUTHORITY, mintConfig: mint.pubkey.toBase58(),
          operationsConfig: operations.pubkey.toBase58(), manifestSha256: manifest.sha256,
        }, new Date());
        record.activationSignature = requireMiNoteSmokeActivationAnchor(journal, runId);
        const status = (await connection.getSignatureStatuses([record.activationSignature], { searchTransactionHistory: true })).value[0];
        if (!status || status.err || status.confirmationStatus !== 'finalized' || mint.minted !== 0) {
          throw new Error('Missing preflight record requires finalized activation and zero minted packs before any continuation.');
        }
        await proveMiNoteSmokeBuyerUnused(connection, buyer.publicKey);
      }
      record.mintConfig = mint.pubkey.toBase58();
      record.operationsConfig = operations.pubkey.toBase58();
      record.metadataBase = drop.metadataBase;
      record.manifestSha256 = manifest.sha256;
      record.preorderBefore = prepared.preorderBefore;
      record.fundingLamports = prepared.fundingLamports;
      const funding = transaction(authority.publicKey, [SystemProgram.transfer({
        fromPubkey: authority.publicKey, toPubkey: buyer.publicKey, lamports: record.fundingLamports,
      })]);
      funding.message.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      funding.sign([authority]);
      const simulation = await connection.simulateTransaction(funding, { commitment: 'confirmed', sigVerify: true });
      if (simulation.value.err) throw new Error('Initial smoke funding simulation failed.');
      persist();
      approved = await confirm(`DEVNET ONLY: ${DROP_ID}\nAuthority: ${AUTHORITY}\nBuyer: ${buyer.publicKey.toBase58()}\nCollection: ${COLLECTION}\nRPC host: ${scriptSolanaRpcHost(rpcUrl)}\nAPI: ${origin}/api\nMint one 0.25 SOL pack; split proceeds equally between ${mint.paymentRouting.mintProceeds.map(({ address }) => address.toBase58()).join(' and ')}.\nFund buyer with ${record.fundingLamports / 1e9} SOL (absolute cap 0.5 SOL); funding simulation passed (${simulation.value.unitsConsumed ?? 0} CU).\nOpen through B and the live reveal API, verify two eligible cards, deliver them to the authority with zero shipping fee, mint one pack and two card receipts to the authority, and refund buyer SOL. No shipping order or email.\nRecovery ID: ${runId}`) === true;
      if (!approved) { record.status = 'cancelled'; persist(); return record; }
      record.status = 'running';
      delete record.diagnostic;
      stage('buyer-authentication');
      await api.authenticate(buyer);
      await api.probeReveal(buyer.publicKey.toBase58());
      stage('fund-buyer');
      await submit('fund buyer', funding, [authority]);
      stage('mint-A');
      const minted = await modules.minter.buildMintBoxesTxWithAccounts(connection, mint, buyer.publicKey, 1, projected);
      const asset = minted.boxAccounts[0];
      const pending = PublicKey.findProgramAddressSync([Buffer.from('open'), asset.toBuffer()], new PublicKey(PROGRAM))[0];
      const cards = [0, 1].map((index) => PublicKey.findProgramAddressSync([Buffer.from('pdude'), pending.toBuffer(), Buffer.from([index])], new PublicKey(PROGRAM))[0]);
      record.pack = { address: asset.toBase58(), pending: pending.toBase58(), cards: cards.map((card) => card.toBase58()) };
      record.knownAssets = [record.pack.address, ...record.pack.cards];
      persist();
      await submit('mint A pack', minted.tx, [buyer]);
      const packAccount = await connection.getAccountInfo(asset, 'finalized');
      const pack = packAccount && modules.core.decodePreorderAssetAccount(packAccount.data);
      const stem = pack?.uri.startsWith(`${drop.metadataBase}/b`) ? pack.uri.slice(`${drop.metadataBase}/b`.length) : '';
      const packId = /^[1-9]\d*\.json$/.test(stem) ? Number(stem.slice(0, -5)) : 0;
      if (!pack || !packAccount!.owner.equals(CORE) || pack.owner !== buyer.publicKey.toBase58() || pack.collection !== COLLECTION ||
        !Number.isSafeInteger(packId) || packId < 1 || packId > 704) throw new Error('Minted smoke pack failed identity verification.');
      record.pack.id = packId;
      stage('start-open-B');
      const opened = await modules.minter.buildStartOpenBoxTxWithPending(connection, operations, buyer.publicKey, asset, projected);
      if (!opened.pendingPda.equals(pending)) throw new Error('Unexpected smoke pending PDA.');
      await submit('start open B', opened.tx, [buyer]);
      await reveal(manifest);
      for (const [index, address] of cards.entries()) {
        const account = await connection.getAccountInfo(address, 'finalized');
        const card = account && modules.core.decodePreorderAssetAccount(account.data);
        if (!card || !account!.owner.equals(CORE) || card.owner !== buyer.publicKey.toBase58() || card.collection !== COLLECTION ||
          card.uri !== `${drop.metadataBase}/f${record.reveal!.ids[index]}.json`) throw new Error('Revealed smoke card failed identity verification.');
      }
      if (await connection.getAccountInfo(pending, 'finalized')) throw new Error('Smoke reveal left its pending account open.');
      const runtime = {
        config: { ...projected, deliveryLookupTable: drop.deliveryLookupTable }, dropId: DROP_ID, cluster: 'devnet',
        boxMinterProgramId: new PublicKey(PROGRAM), boxMinterConfigPda: operations.pubkey, collectionMint: new PublicKey(COLLECTION),
        receiptsMerkleTree: new PublicKey(drop.receiptsMerkleTree), itemsPerBox: 2, maxSupply: 704, maxDudeId: 1430,
      };
      stage('zero-fee-card-delivery-B');
      let deliveryId = createHash('sha256').update(`delivery:${runId}`).digest().readUInt32LE() || 1;
      let delivery: PublicKey;
      let bump: number;
      for (let attempt = 0; ; attempt += 1) {
        [delivery, bump] = PublicKey.findProgramAddressSync([Buffer.from('delivery'), operations.pubkey.toBuffer(), u32(deliveryId)], new PublicKey(PROGRAM));
        if (!await connection.getAccountInfo(delivery, 'finalized')) break;
        if (attempt >= 10 || deliveryId === 0xffff_ffff) throw new Error('No unused smoke delivery record ID.');
        deliveryId += 1;
      }
      const deliver = new TransactionInstruction({ programId: new PublicKey(PROGRAM), keys: [
        { pubkey: operations.pubkey, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
        { pubkey: operations.treasury, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(COLLECTION), isSigner: false, isWritable: false },
        { pubkey: CORE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: NOOP, isSigner: false, isWritable: false },
        { pubkey: delivery!, isSigner: false, isWritable: true },
        ...cards.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ], data: Buffer.concat([instructionDiscriminator('deliver'), u32(deliveryId), Buffer.alloc(8), Buffer.from([bump!])]) });
      const close = modules.receipts.closeDeliveryInstruction({ runtime, signer: authority.publicKey, deliveryPda: delivery!, deliveryId, deliveryBump: bump! });
      await submit('deliver and close B', transaction(authority.publicKey, [deliver, close]), [authority, buyer]);
      if (await connection.getAccountInfo(delivery!, 'finalized')) throw new Error('Smoke delivery record did not close.');
      for (const card of cards) {
        const account = await connection.getAccountInfo(card, 'finalized');
        if (!account || modules.core.decodePreorderAssetAccount(account.data)?.owner !== authority.publicKey.toBase58()) {
          throw new Error('Smoke card delivery did not return ownership to the authority.');
        }
      }
      stage('mint-pack-and-card-receipts-B');
      const receipts = modules.receipts.mintReceiptsInstruction({ runtime, signer: authority.publicKey, recipient: authority.publicKey,
        coreCollection: new PublicKey(COLLECTION), boxIds: [packId], dudeIds: record.reveal!.ids });
      const signature = await submit('mint B receipts', transaction(authority.publicKey, [receipts]), [authority]);
      const uris = [`${drop.metadataBase}/rb${packId}.json`, ...record.reveal!.ids.map((id) => `${drop.metadataBase}/rf${id}.json`)];
      await verifyReceiptMint(connection, signature, authority.publicKey, uris);
      record.receipts = { signature, tree: drop.receiptsMerkleTree, uris, recipient: authority.publicKey.toBase58() };
      await modules.minter.fetchBoxMinterConfig(connection, projected, 'operations');
      record.preorderAfter = await readMiNoteSmokePreorderFingerprint(connection, drop, manifest);
      if (JSON.stringify(record.preorderAfter) !== JSON.stringify(record.preorderBefore)) throw new Error('Preorder fingerprints changed during smoke.');
      completed = true;
    }
  } catch (error) {
    failure = error;
    record.diagnostic = { stage: record.stage, message: redactMiNoteSmokeError(error, rpcUrl), at: new Date().toISOString() };
    if (!approved) record.status = 'preflight-failed';
    persist();
  }
  finally {
    try {
    if (approved) {
      try {
        stage('cleanup');
        const cleanupErrors: unknown[] = [];
        for (const address of record.knownAssets) {
          try {
          const account = await connection.getAccountInfo(new PublicKey(address), 'finalized');
          if (!account || !account.owner.equals(CORE) || account.data[0] !== 1 || account.data.length < 33 ||
            !new PublicKey(account.data.subarray(1, 33)).equals(buyer.publicKey)) continue;
          const asset = modules.core.decodePreorderAssetAccount(account.data);
          if (!asset || asset.collection !== COLLECTION) throw new Error('Buyer asset cannot be safely returned through the smoke collection.');
          await submit(`return asset ${address}`, transaction(authority.publicKey, [coreTransfer(new PublicKey(address), buyer.publicKey, authority.publicKey)]), [authority, buyer]);
          } catch (error) { cleanupErrors.push(error); }
        }
        try {
          const balance = await connection.getBalance(buyer.publicKey, 'finalized');
          if (balance > 0) await submit('refund buyer SOL', transaction(authority.publicKey, [SystemProgram.transfer({
            fromPubkey: buyer.publicKey, toPubkey: authority.publicKey, lamports: balance,
          })]), [authority, buyer]);
        } catch (error) { cleanupErrors.push(error); }
        const buyerOwnedAssets: string[] = [];
        const unexpectedOwners: string[] = [];
        for (const address of record.knownAssets) {
          const account = await connection.getAccountInfo(new PublicKey(address), 'finalized');
          if (account?.owner.equals(CORE) && account.data[0] === 1 && account.data.length >= 33) {
            const owner = new PublicKey(account.data.subarray(1, 33));
            if (owner.equals(buyer.publicKey)) buyerOwnedAssets.push(address);
            else if (!owner.equals(authority.publicKey)) unexpectedOwners.push(address);
          }
        }
        record.cleanup = { buyerLamports: await connection.getBalance(buyer.publicKey, 'finalized'), buyerOwnedAssets, unexpectedOwners,
          pendingOpen: Boolean(record.pack && await connection.getAccountInfo(new PublicKey(record.pack.pending), 'finalized')) };
        if (cleanupErrors.length || record.cleanup.buyerLamports || buyerOwnedAssets.length || unexpectedOwners.length || record.cleanup.pendingOpen || record.transactions.some(({ status }) => status === 'pending')) {
          throw new Error('Smoke cleanup requires recovery.');
        }
      } catch (error) { failure ||= error; }
      if (auditedDrop && auditedManifest && record.preorderBefore) {
        try {
          record.preorderAfter = await readMiNoteSmokePreorderFingerprint(connection, auditedDrop, auditedManifest);
          if (JSON.stringify(record.preorderBefore) !== JSON.stringify(record.preorderAfter)) throw new Error('Preorder fingerprints changed during smoke.');
        } catch (error) { failure ||= error; }
      }
      try { await api.logout(); } catch { }
      if (failure && !record.diagnostic) record.diagnostic = {
        stage: record.stage, message: redactMiNoteSmokeError(failure, rpcUrl), at: new Date().toISOString(),
      };
      record.status = completed && !failure ? performedFullSmoke ? 'passed' : 'recovered' : 'recovery-required';
      record.stage = record.status;
      persist();
    }
    } finally { derived.destroy(); }
  }
  if (failure) throw new Error(`Smoke failed at ${record.diagnostic?.stage ?? record.stage}: ${record.diagnostic?.message ?? redactMiNoteSmokeError(failure, rpcUrl)}\nPublic state: ${file}\nRecover with --recover ${runId}.`, {
    cause: new Error(record.diagnostic?.message ?? redactMiNoteSmokeError(failure, rpcUrl)),
  });
  return record;
}

async function main() {
  const options = parseMiNoteSmokeArgs(process.argv.slice(2));
  if (options.check) {
    console.log(JSON.stringify(await checkMiNoteDevnetSmoke(options), null, 2));
    return;
  }
  const raw = await promptMaskedInput('Mi Note devnet authority private key (memory only): ');
  const authority = parsePrivateKeyInput(raw);
  const record = await runMiNoteDevnetSmoke({ ...options, authority });
  console.log(`Smoke ${record.runId}: ${record.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Smoke failed.'); process.exitCode = 1; });
}
