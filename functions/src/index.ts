import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import type { Request, Response } from 'express';
import * as functions from 'firebase-functions';
import {
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  createBurnInstruction,
  createMintToCollectionV1Instruction,
} from '@metaplex-foundation/mpl-bubblegum';
import { SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, SPL_NOOP_PROGRAM_ID } from '@solana/spl-account-compression';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import nacl from 'tweetnacl';
import { randomBytes, randomInt } from 'crypto';
import { z } from 'zod';

const app = initializeApp();
const db = getFirestore(app);
const auth = getAuth(app);
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function maybeHandleCors(req: Request, res: Response) {
  res.set(corsHeaders);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

const DUDES_PER_BOX = 3;
const devSupply = Number(process.env.TEST_SUPPLY || 11);
const prodSupply = Number(process.env.TOTAL_SUPPLY || 333);
const CLAIM_LOCK_WINDOW_MS = 5 * 60 * 1000;
const MINT_SYNC_TTL_MS = 30_000;
let lastMintSyncAttemptMs = 0;
let mintSyncInFlight: Promise<void> | null = null;

const cluster = (process.env.SOLANA_CLUSTER || 'devnet') as 'devnet' | 'testnet' | 'mainnet-beta';
const totalSupply = cluster === 'mainnet-beta' ? prodSupply : devSupply;
const totalDudes = totalSupply * DUDES_PER_BOX;
const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl(cluster);

const merkleTree = new PublicKey(process.env.MERKLE_TREE || PublicKey.default.toBase58());
const collectionMint = new PublicKey(process.env.COLLECTION_MINT || PublicKey.default.toBase58());
const collectionMetadata = new PublicKey(process.env.COLLECTION_METADATA || PublicKey.default.toBase58());
const collectionMasterEdition = new PublicKey(
  process.env.COLLECTION_MASTER_EDITION || PublicKey.default.toBase58(),
);
const collectionUpdateAuthority = new PublicKey(
  process.env.COLLECTION_UPDATE_AUTHORITY || PublicKey.default.toBase58(),
);
const shippingVault = new PublicKey(process.env.DELIVERY_VAULT || PublicKey.default.toBase58());
const metadataBase = process.env.METADATA_BASE || 'https://assets.mons.link/metadata';
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const collectionMintStr = collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58();

function heliusRpcEndpoint() {
  const custom = process.env.HELIUS_RPC_URL || process.env.HELIUS_RPC;
  if (custom) return custom;
  const helius = process.env.HELIUS_API_KEY;
  if (!helius) throw new Error('Missing HELIUS_API_KEY');
  const base = `https://rpc.helius.xyz/?api-key=${helius}`;
  return cluster === 'mainnet-beta' ? base : `${base}&cluster=${cluster}`;
}

const treeAuthority = () =>
  Keypair.fromSecretKey(bs58.decode(process.env.TREE_AUTHORITY_SECRET || ''));
const cosigner = () => Keypair.fromSecretKey(bs58.decode(process.env.COSIGNER_SECRET || process.env.TREE_AUTHORITY_SECRET || ''));

function memoInstruction(data: string) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(data),
  });
}

function collectionAuthorityRecordPda() {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      collectionMint.toBuffer(),
      Buffer.from('collection_authority'),
      collectionUpdateAuthority.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function connection() {
  return new Connection(rpcUrl, 'confirmed');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSignature(sig: number[] | string) {
  if (typeof sig === 'string') return bs58.decode(sig);
  return Uint8Array.from(sig);
}

function buildMetadata(
  kind: 'box' | 'dude' | 'certificate',
  index: number,
  extra?: { boxId?: string; dudeIds?: number[] },
): MetadataArgs {
  const dudes = (extra?.dudeIds || []).filter((id) => Number.isFinite(id)) as number[];
  const primaryDudeId = dudes[0] ?? index;
  const certificateTarget = kind === 'certificate' ? (extra?.boxId ? 'box' : dudes.length === 1 ? 'dude' : undefined) : undefined;
  const allowDudeAttrs = kind !== 'certificate' || certificateTarget === 'dude';
  const name = (() => {
    if (kind === 'box') return `mons blind box #${index}`;
    if (kind === 'dude') return `mons dude #${primaryDudeId}`;
    if (certificateTarget === 'dude') return `mons certificate · dude #${primaryDudeId}`;
    if (certificateTarget === 'box') return `mons certificate · box ${extra?.boxId?.slice(0, 6) || index}`;
    return `mons authenticity #${index}`;
  })();

  const uriSuffix =
    kind === 'box'
      ? 'box.json'
      : kind === 'dude'
        ? `dude/${primaryDudeId}.json`
        : certificateTarget === 'dude'
          ? `certificate/dude-${primaryDudeId}.json`
          : certificateTarget === 'box' && extra?.boxId
            ? `certificate/box-${extra.boxId}.json`
            : 'certificate.json';

  const attrs = [
    { trait_type: 'type', value: kind },
    extra?.boxId ? { trait_type: 'box_id', value: extra.boxId } : null,
    allowDudeAttrs && dudes.length === 1 ? { trait_type: 'dude_id', value: `${primaryDudeId}` } : null,
    allowDudeAttrs && dudes.length > 1 ? { trait_type: 'dude_ids', value: dudes.join(',') } : null,
    certificateTarget ? { trait_type: 'certificate_for', value: certificateTarget } : null,
  ].filter(Boolean) as { trait_type: string; value: string }[];

  return {
    name,
    symbol: 'MONS',
    uri: `${metadataBase}/${uriSuffix}`,
    sellerFeeBasisPoints: 0,
    creators: [{ address: treeAuthority().publicKey, verified: false, share: 100 }],
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: TokenStandard.NonFungible,
    collection: { key: collectionMint, verified: false },
    uses: null,
  };
}

async function buildMintInstructions(owner: PublicKey, quantity: number, kind: 'box' | 'dude' | 'certificate', startIndex = 1, extra?: { boxId?: string; dudeIds?: number[] }) {
  const instructions: TransactionInstruction[] = [];
  const bubblegumSigner = PublicKey.findProgramAddressSync([Buffer.from('collection_cpi')], BUBBLEGUM_PROGRAM_ID)[0];
  const collectionAuthorityRecord = collectionAuthorityRecordPda();
  const treeAuthorityKey = treeAuthority();

  for (let i = 0; i < quantity; i += 1) {
    const perMintDudeIds =
      extra?.dudeIds && (quantity > 1 || kind === 'dude') ? [extra.dudeIds[i]] : extra?.dudeIds;
    const metadataArgs = buildMetadata(kind, startIndex + i, {
      boxId: extra?.boxId,
      dudeIds: perMintDudeIds?.filter((id) => Number.isFinite(id)) as number[] | undefined,
    });
    instructions.push(
      createMintToCollectionV1Instruction(
        {
          payer: owner,
          merkleTree,
          treeAuthority: treeAuthorityKey.publicKey,
          treeDelegate: treeAuthorityKey.publicKey,
          leafOwner: owner,
          leafDelegate: owner,
          collectionAuthority: collectionUpdateAuthority,
          collectionMint,
          collectionMetadata,
          editionAccount: collectionMasterEdition,
          bubblegumSigner,
          compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
          logWrapper: SPL_NOOP_PROGRAM_ID,
          collectionAuthorityRecordPda: collectionAuthorityRecord,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        },
        { metadataArgs },
      ),
    );
  }

  return instructions;
}

async function getMintStats() {
  const snap = await db.doc('meta/stats').get();
  const data = snap.exists ? (snap.data() as any) : {};
  const minted = Number(data.minted || 0);
  const remaining = Math.max(0, totalSupply - minted);
  return { minted, remaining, total: totalSupply };
}

async function recordMintedBoxes(signature: string, owner: string, minted: number) {
  if (minted <= 0) return;
  const statsRef = db.doc('meta/stats');
  const txRef = db.doc(`mintTxs/${signature}`);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(txRef);
    if (existing.exists) return;
    const statsSnap = await tx.get(statsRef);
    const stats = statsSnap.exists ? (statsSnap.data() as any) : {};
    const currentMinted = Number(stats.minted || 0);
    tx.set(
      statsRef,
      {
        minted: currentMinted + minted,
        total: totalSupply,
      },
      { merge: true },
    );
    tx.set(txRef, {
      signature,
      owner,
      minted,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}

async function processMintSignature(signature: string) {
  const exists = await db.doc(`mintTxs/${signature}`).get();
  if (exists.exists) return null;
  const txInfo = await connection().getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!txInfo || txInfo.meta?.err) return null;
  if (!hasMintMemo(txInfo)) return null;
  const payer = getPayerFromTx(txInfo);
  if (!payer) return null;
  const mintCount = countMintInstructions(txInfo, payer);
  if (mintCount <= 0) return null;
  await recordMintedBoxes(signature, payer.toBase58(), mintCount);
  return { mintCount, payer: payer.toBase58() };
}

async function syncMintedFromChain(limit = 100) {
  const conn = connection();
  let before: string | undefined;
  let processed = 0;
  while (processed < limit) {
    const sigs = await conn.getSignaturesForAddress(treeAuthority().publicKey, {
      limit: 20,
      before,
    });
    if (!sigs.length) break;
    for (const sig of sigs) {
      before = sig.signature;
      if (sig.err) continue;
      const already = await db.doc(`mintTxs/${sig.signature}`).get();
      if (already.exists) continue;
      const result = await processMintSignature(sig.signature);
      if (result) processed += 1;
    }
    if (sigs.length < 20) break;
  }
}

async function maybeSyncMintedFromChain(force = false) {
  const now = Date.now();
  const recentlyAttempted = now - lastMintSyncAttemptMs < MINT_SYNC_TTL_MS;
  if (!force && recentlyAttempted) {
    return mintSyncInFlight || Promise.resolve();
  }
  if (mintSyncInFlight) return mintSyncInFlight;
  lastMintSyncAttemptMs = now;
  mintSyncInFlight = syncMintedFromChain()
    .catch((err) => {
      functions.logger.error('syncMintedFromChain failed', err);
    })
    .finally(() => {
      lastMintSyncAttemptMs = Date.now();
      mintSyncInFlight = null;
    });
  return mintSyncInFlight;
}

async function heliusJson(url: string, label: string, retries = 3, backoffMs = 400) {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt === retries) {
        throw new Error(`${label} ${res.status}`);
      }
      await sleep(backoffMs * 2 ** attempt);
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      await sleep(backoffMs * 2 ** attempt);
    }
    attempt += 1;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function heliusRpc<T>(method: string, params: any, label: string): Promise<T> {
  const url = heliusRpcEndpoint();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: label, method, params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const message = json?.error?.message || res.statusText || 'Unknown Helius RPC error';
    throw new Error(`${label} ${message}`);
  }
  return json.result as T;
}

async function fetchAssetsOwned(owner: string) {
  const grouping = collectionMintStr ? [{ groupKey: 'collection', groupValue: collectionMintStr }] : undefined;
  const result = await heliusRpc<any>(
    'searchAssets',
    {
      ownerAddress: owner,
      grouping,
      page: 1,
      limit: 1000,
      displayOptions: {
        showCollectionMetadata: true,
        showUnverifiedCollections: true,
      },
    },
    'Helius assets error',
  );
  return Array.isArray(result?.items) ? result.items : [];
}

async function findCertificateForBox(owner: string, boxId: string) {
  if (!boxId) return null;
  const assets = await fetchAssetsOwned(owner);
  return assets.find((asset: any) => getAssetKind(asset) === 'certificate' && getBoxIdFromAsset(asset) === boxId) || null;
}

async function fetchAssetProof(assetId: string) {
  const helius = process.env.HELIUS_API_KEY;
  const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
  const url = `https://api.helius.xyz/v0/assets/${assetId}/proof?api-key=${helius}${clusterParam}`;
  return heliusJson(url, 'Helius proof error');
}

async function fetchAsset(assetId: string) {
  const helius = process.env.HELIUS_API_KEY;
  const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
  const url = `https://api.helius.xyz/v0/assets?ids[]=${assetId}&api-key=${helius}${clusterParam}`;
  const json = await heliusJson(url, 'Helius asset error');
  return json[0];
}

function getAssetKind(asset: any): 'box' | 'dude' | 'certificate' | null {
  const kindAttr = asset?.content?.metadata?.attributes?.find((a: any) => a.trait_type === 'type');
  const value = kindAttr?.value;
  return value === 'box' || value === 'dude' || value === 'certificate' ? value : null;
}

function getBoxIdFromAsset(asset: any): string | undefined {
  const boxAttr = asset?.content?.metadata?.attributes?.find((a: any) => a.trait_type === 'box_id');
  return boxAttr?.value;
}

function getDudeIdFromAsset(asset: any): number | undefined {
  const dudeAttr = asset?.content?.metadata?.attributes?.find((a: any) => a.trait_type === 'dude_id');
  const num = Number(dudeAttr?.value);
  return Number.isFinite(num) ? num : undefined;
}

function isMonsAsset(asset: any): boolean {
  const inCollection =
    !collectionMintStr ||
    (asset?.grouping || []).some((g: any) => g.group_key === 'collection' && g.group_value === collectionMintStr);
  const kind = getAssetKind(asset);
  return Boolean(inCollection && kind);
}

async function fetchAssetWithProof(assetId: string) {
  const [asset, proof] = await Promise.all([fetchAsset(assetId), fetchAssetProof(assetId)]);
  return { asset, proof };
}

async function createBurnIx(assetId: string, owner: PublicKey, cached?: { asset?: any; proof?: any }) {
  const asset = cached?.asset ?? (await fetchAsset(assetId));
  const proof = cached?.proof ?? (await fetchAssetProof(assetId));
  const leafNonce = proof.leaf?.nonce ?? asset.compression?.leaf_id ?? 0;
  const merkle = new PublicKey(asset.compression?.tree || proof.merkleTree);
  const proofPath = (proof.proof || []).map((p: string) => ({
    pubkey: new PublicKey(p),
    isSigner: false,
    isWritable: false,
  }));

  const ix = createBurnInstruction(
    {
      treeAuthority: treeAuthority().publicKey,
      leafOwner: new PublicKey(asset.ownership.owner),
      leafDelegate: owner,
      merkleTree: merkle,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      anchorRemainingAccounts: proofPath,
    },
    {
      root: Array.from(bs58.decode(proof.root)),
      dataHash: Array.from(bs58.decode(asset.compression.data_hash)),
      creatorHash: Array.from(bs58.decode(asset.compression.creator_hash)),
      nonce: leafNonce,
      index: proof.node_index ?? asset.compression?.leaf_id ?? 0,
    },
  );
  return ix;
}

async function assignDudes(boxId: string): Promise<number[]> {
  const ref = db.doc(`boxAssignments/${boxId}`);
  const poolRef = db.doc('meta/dudePool');
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return (existing.data() as any).dudeIds as number[];
    const poolSnap = await tx.get(poolRef);
    const pool = (poolSnap.data() as any)?.available || Array.from({ length: totalDudes }, (_, i) => i + 1);
    if (pool.length < DUDES_PER_BOX) throw new Error('No dudes remaining to assign');
    const chosen: number[] = [];
    for (let i = 0; i < DUDES_PER_BOX; i += 1) {
      const pick = randomInt(0, pool.length);
      chosen.push(pool[pick]);
      pool.splice(pick, 1);
    }
    tx.set(poolRef, { available: pool }, { merge: true });
    tx.set(ref, { dudeIds: chosen, createdAt: FieldValue.serverTimestamp() });
    return chosen;
  });
}

async function ensureClaimCode(boxId: string, dudeIds: number[], owner: string) {
  const existing = await db.collection('claimCodes').where('boxId', '==', boxId).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;
  let code = '';
  let ref = db.doc(`claimCodes/placeholder`);
  do {
    code = randomBytes(4).toString('hex').toUpperCase();
    ref = db.doc(`claimCodes/${code}`);
  } while ((await ref.get()).exists);

  await ref.set({
    boxId,
    dudeIds,
    owner,
    createdAt: FieldValue.serverTimestamp(),
  });
  return code;
}

function certificateIndexForItem(assetId: string, kind: 'box' | 'dude', dudeIds?: number[]) {
  if (kind === 'dude' && dudeIds?.[0]) return dudeIds[0];
  const input = `${kind}:${assetId}:${(dudeIds || []).join(',')}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return (hash % 1_000_000) + 1;
}

function buildTx(instructions: TransactionInstruction[], payer: PublicKey, recentBlockhash: string) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([treeAuthority(), cosigner()]);
  return tx;
}

function transformInventoryItem(asset: any) {
  const kind = getAssetKind(asset);
  if (!kind) return null;
  const boxId = getBoxIdFromAsset(asset);
  const dudeId = getDudeIdFromAsset(asset);
  return {
    id: asset.id,
    name: asset.content?.metadata?.name || asset.id,
    kind,
    boxId,
    dudeId,
    image: asset.content?.links?.image,
    attributes: asset.content?.metadata?.attributes || [],
    status: asset.compression?.compressed ? 'minted' : 'unknown',
  };
}

function normalizeCountryCode(country?: string) {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s.]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA') return 'US';
  return '';
}

function shippingZone(country?: string): 'us' | 'intl' {
  const code = normalizeCountryCode(country);
  if (code === 'US' || code === 'PR' || code === 'GU' || code === 'VI' || code === 'AS') return 'us';
  const normalized = (country || '').trim().toLowerCase();
  if (normalized.includes('united states')) return 'us';
  return 'intl';
}

function shippingLamports(country: string, items: number) {
  const zone = shippingZone(country);
  const base = zone === 'us' ? 0.15 : 0.32;
  const multiplier = Math.max(1, items * 0.35);
  return Math.round(base * multiplier * LAMPORTS_PER_SOL);
}

async function verifyAuth(req: Request) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) throw new functions.https.HttpsError('unauthenticated', 'Missing auth token');
  const decoded = await auth.verifyIdToken(token);
  return decoded.uid;
}

function resolveInstructionAccounts(tx: any): PublicKey[] {
  if (!tx?.transaction?.message) return [];
  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const lookupWritable = (accountKeys?.accountKeysFromLookups?.writable || []).map((k: any) => new PublicKey(k));
  const lookupReadonly = (accountKeys?.accountKeysFromLookups?.readonly || []).map((k: any) => new PublicKey(k));
  const staticKeys = (accountKeys?.staticAccountKeys || []).map((k: any) => new PublicKey(k));
  return [...staticKeys, ...lookupWritable, ...lookupReadonly];
}

function getPayerFromTx(tx: any): PublicKey | null {
  const accounts = resolveInstructionAccounts(tx);
  return accounts.length ? accounts[0] : null;
}

function hasMintMemo(tx: any) {
  const keys = resolveInstructionAccounts(tx);
  return (tx?.transaction?.message?.compiledInstructions || []).some((ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(MEMO_PROGRAM_ID)) return false;
    const dataField = (ix as any).data;
    const dataBuffer =
      typeof dataField === 'string'
        ? Buffer.from(bs58.decode(dataField))
        : Buffer.from(dataField || []);
    return dataBuffer.toString() === 'mint:boxes';
  });
}

function countMintInstructions(tx: any, ownerPk: PublicKey) {
  const keys = resolveInstructionAccounts(tx);
  return (tx?.transaction?.message?.compiledInstructions || []).reduce((count: number, ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(BUBBLEGUM_PROGRAM_ID)) return count;
    const accountIndexes = ix.accounts || ix.accountKeyIndexes || [];
    const ixAccounts = accountIndexes.map((idx: number) => keys[idx]);
    const touchesTree = ixAccounts.some((k: PublicKey) => k.equals(merkleTree));
    const touchesOwner = ixAccounts.some((k: PublicKey) => k.equals(ownerPk));
    return touchesTree && touchesOwner ? count + 1 : count;
  }, 0);
}

function extractMemos(tx: any): string[] {
  const keys = resolveInstructionAccounts(tx);
  return (tx?.transaction?.message?.compiledInstructions || []).reduce((memos: string[], ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(MEMO_PROGRAM_ID)) return memos;
    const dataField = (ix as any).data;
    const dataBuffer =
      typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
    const text = dataBuffer.toString();
    return text ? [...memos, text] : memos;
  }, []);
}

function findClaimMemo(tx: any, code: string) {
  const memos = extractMemos(tx);
  return memos.find((m) => m === `claim:${code}` || m.startsWith(`claim:${code}:`));
}

function extractCompressedAssetIds(tx: any) {
  const logs: string[] = tx?.meta?.logMessages || [];
  const regex = /asset(?:\s+|-)id[:\s]*([1-9A-HJ-NP-Za-km-z]{32,44})/i;
  const found = new Set<string>();
  logs.forEach((line) => {
    const match = typeof line === 'string' ? line.match(regex) : null;
    if (match?.[1]) found.add(match[1]);
  });
  return Array.from(found);
}

function lamportsDeltaForAccount(tx: any, account: PublicKey): number {
  const keys = resolveInstructionAccounts(tx);
  const idx = keys.findIndex((k) => k.equals(account));
  if (idx === -1) return 0;
  const pre = Number(tx?.meta?.preBalances?.[idx] || 0);
  const post = Number(tx?.meta?.postBalances?.[idx] || 0);
  return post - pre;
}

async function processClaimSignature(code: string, signature: string, owner: string) {
  const tx = await connection().getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return null;
  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== owner) return null;
  const memo = findClaimMemo(tx, code);
  if (!memo) return null;
  return { signature, payer: payer.toBase58(), memo };
}

async function detectClaimOnChain(code: string, owner: string, limit = 20): Promise<string | null> {
  const sigs = await connection().getSignaturesForAddress(new PublicKey(owner), { limit });
  for (const sig of sigs) {
    if (sig.err) continue;
    const processed = await processClaimSignature(code, sig.signature, owner);
    if (processed) return processed.signature;
  }
  return null;
}

export const solanaAuth = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const schema = z.object({ wallet: z.string(), message: z.string(), signature: z.array(z.number()) });
  const { wallet, message, signature } = schema.parse(req.body);
  const pubkey = new PublicKey(wallet);
  const verified = nacl.sign.detached.verify(new TextEncoder().encode(message), parseSignature(signature), pubkey.toBytes());
  if (!verified) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const userRecord = await auth.getUser(wallet).catch(() => null);
  if (!userRecord) {
    await auth.createUser({ uid: wallet, email: `${wallet}@mons.shop` }).catch(() => undefined);
  }
  const customToken = await auth.createCustomToken(wallet);
  const profileRef = db.doc(`profiles/${wallet}`);
  const snap = await profileRef.get();
  const addressesSnap = await db.collection(`profiles/${wallet}/addresses`).get();
  const addresses = addressesSnap.docs.map((doc) => doc.data());
  const profileData = snap.exists ? (snap.data() as any) : { wallet };
  if (!snap.exists) await profileRef.set(profileData);
  res.json({
    customToken,
    profile: {
      ...profileData,
      wallet,
      email: profileData.email || userRecord?.email,
      addresses,
    },
  });
});

export const stats = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  await maybeSyncMintedFromChain();
  const stats = await getMintStats();
  res.json(stats);
});

export const inventory = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  const owner = (req.query.owner as string) || '';
  if (!owner) {
    res.status(400).json({ error: 'owner required' });
    return;
  }
  const assets = await fetchAssetsOwned(owner);
  const items = (assets || [])
    .filter(isMonsAsset)
    .map(transformInventoryItem)
    .filter(Boolean);
  res.json(items);
});

export const saveAddress = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({
    encrypted: z.string(),
    country: z.string(),
    countryCode: z.string().optional(),
    label: z.string().default('Home'),
    hint: z.string(),
    email: z.string().email().optional(),
  });
  const body = schema.parse(req.body);
  const id = db.collection('tmp').doc().id;
  const countryCode = normalizeCountryCode(body.countryCode || body.country);
  const addressRef = db.doc(`profiles/${uid}/addresses/${id}`);
  await addressRef.set(
    {
      ...body,
      countryCode: countryCode || body.countryCode,
      id,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await db.doc(`profiles/${uid}`).set(
    { wallet: uid, ...(body.email ? { email: body.email } : {}) },
    { merge: true },
  );
  res.json({
    id,
    label: body.label,
    country: body.country,
    countryCode: countryCode || body.countryCode,
    encrypted: body.encrypted,
    hint: body.hint,
    email: body.email,
  });
});

export const prepareMintTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  await maybeSyncMintedFromChain();
  const schema = z.object({ owner: z.string(), quantity: z.number().min(1).max(20) });
  const { owner, quantity } = schema.parse(req.body);
  const ownerPk = new PublicKey(owner);
  const stats = await getMintStats();
  const remaining = Math.max(0, stats.remaining);
  if (remaining <= 0) {
    throw new functions.https.HttpsError('failed-precondition', 'Minted out');
  }
  const mintQty = Math.min(quantity, remaining);
  const conn = connection();
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    memoInstruction('mint:boxes'),
  ];
  instructions.push(...(await buildMintInstructions(ownerPk, mintQty, 'box', stats.minted + 1)));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  res.json({
    encodedTx: Buffer.from(tx.serialize()).toString('base64'),
    allowedQuantity: mintQty,
  });
});

export const finalizeMintTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const schema = z.object({ owner: z.string(), signature: z.string() });
  const { owner, signature } = schema.parse(req.body);
  const authHeader = req.headers.authorization || '';
  if (authHeader) {
    const uid = await verifyAuth(req);
    if (uid !== owner) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  }
  const processed = await processMintSignature(signature);
  if (!processed) {
    throw new functions.https.HttpsError('failed-precondition', 'Mint transaction not found or already recorded');
  }
  if (processed.payer !== owner) {
    throw new functions.https.HttpsError('failed-precondition', 'Signature payer does not match owner');
  }
  const stats = await getMintStats();
  res.json({ ...stats, recorded: processed.mintCount });
});

export const prepareOpenBoxTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const schema = z.object({ owner: z.string(), boxAssetId: z.string() });
  const { owner, boxAssetId } = schema.parse(req.body);
  const ownerPk = new PublicKey(owner);
  const conn = connection();
  const { asset, proof } = await fetchAssetWithProof(boxAssetId);
  const kind = getAssetKind(asset);
  if (kind !== 'box') {
    throw new functions.https.HttpsError('failed-precondition', 'Only blind boxes can be opened');
  }
  if (!isMonsAsset(asset)) {
    throw new functions.https.HttpsError('failed-precondition', 'Item is not part of the Mons collection');
  }
  const assetOwner = asset?.ownership?.owner;
  if (assetOwner !== owner) {
    throw new functions.https.HttpsError('failed-precondition', 'Box not owned by wallet');
  }
  const dudeIds = await assignDudes(boxAssetId);
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 })];
  instructions.push(await createBurnIx(boxAssetId, ownerPk, { asset, proof }));
  instructions.push(...(await buildMintInstructions(ownerPk, DUDES_PER_BOX, 'dude', dudeIds[0], { boxId: boxAssetId, dudeIds })));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  res.json({ encodedTx: Buffer.from(tx.serialize()).toString('base64'), assignedDudeIds: dudeIds });
});

export const prepareDeliveryTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({ owner: z.string(), itemIds: z.array(z.string()).min(1), addressId: z.string() });
  const { owner, itemIds, addressId } = schema.parse(req.body);
  if (uid !== owner) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(owner);
  const conn = connection();
  const addressSnap = await db.doc(`profiles/${uid}/addresses/${addressId}`).get();
  if (!addressSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Address not found');
  }
  const addressData = addressSnap.data();
  const addressCountry = addressData?.countryCode || normalizeCountryCode(addressData?.country) || addressData?.country || '';
  const orderId = db.collection('deliveryOrders').doc().id;
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
    memoInstruction(`delivery:${orderId}`),
  ];
  const orderItems: {
    assetId: string;
    kind: 'box' | 'dude';
    boxId?: string;
    dudeIds?: number[];
    certificateIndex: number;
    claimCode?: string;
  }[] = [];
  for (let i = 0; i < itemIds.length; i += 1) {
    const id = itemIds[i];
    const assetData = await fetchAssetWithProof(id);
    const kind = getAssetKind(assetData.asset);
    if (!kind) {
      throw new functions.https.HttpsError('failed-precondition', 'Unsupported asset type');
    }
    if (!isMonsAsset(assetData.asset)) {
      throw new functions.https.HttpsError('failed-precondition', 'Item is not part of the Mons collection');
    }
    const assetOwner = assetData.asset?.ownership?.owner;
    if (assetOwner !== owner) {
      throw new functions.https.HttpsError('failed-precondition', 'Item not owned by wallet');
    }
    if (kind === 'certificate') {
      throw new functions.https.HttpsError('failed-precondition', 'Certificates are already delivery outputs');
    }
    let dudeIds: number[] | undefined;
    let claimCode: string | undefined;
    if (kind === 'box') {
      const assigned = await assignDudes(id);
      dudeIds = assigned;
      claimCode = await ensureClaimCode(id, assigned, owner);
    }
    if (kind === 'dude') {
      const dudeId = getDudeIdFromAsset(assetData.asset);
      dudeIds = dudeId ? [dudeId] : undefined;
    }
    const boxRef = getBoxIdFromAsset(assetData.asset) || (kind === 'box' ? id : undefined);
    const certIndex = certificateIndexForItem(boxRef || id, kind, dudeIds);
    orderItems.push({
      assetId: id,
      kind,
      boxId: boxRef,
      dudeIds,
      certificateIndex: certIndex,
      claimCode,
    });
    instructions.push(await createBurnIx(id, ownerPk, assetData));
    instructions.push(
      ...(await buildMintInstructions(ownerPk, 1, 'certificate', certIndex, {
        boxId: boxRef,
        dudeIds,
      })),
    );
  }
  const deliveryPrice = shippingLamports(addressCountry || 'unknown', itemIds.length);
  instructions.unshift(SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: shippingVault, lamports: deliveryPrice }));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  await db.doc(`deliveryOrders/${orderId}`).set({
    status: 'prepared',
    owner,
    addressId,
    addressSnapshot: {
      ...addressData,
      id: addressId,
      countryCode: addressCountry || addressData?.countryCode,
    },
    itemIds,
    items: orderItems,
    shippingLamports: deliveryPrice,
    createdAt: FieldValue.serverTimestamp(),
  });
  res.json({ encodedTx: Buffer.from(tx.serialize()).toString('base64'), deliveryLamports: deliveryPrice, orderId });
});

export const finalizeDeliveryTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({ owner: z.string(), signature: z.string(), orderId: z.string() });
  const { owner, signature, orderId } = schema.parse(req.body);
  if (uid !== owner) throw new functions.https.HttpsError('permission-denied', 'Owners only');

  const orderRef = db.doc(`deliveryOrders/${orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Delivery order not found');
  }
  const order = orderSnap.data() as any;
  if (order.owner && order.owner !== owner) {
    throw new functions.https.HttpsError('permission-denied', 'Order belongs to a different wallet');
  }
  if (order.signature && order.signature !== signature && order.status === 'completed') {
    res.status(409).json({ error: 'Order already finalized', signature: order.signature });
    return;
  }

  const tx = await connection().getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery transaction not found or failed');
  }
  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== owner) {
    throw new functions.https.HttpsError('failed-precondition', 'Signature payer does not match owner');
  }
  const memo = extractMemos(tx).find((m) => m === `delivery:${orderId}`);
  if (!memo) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery memo not found on transaction');
  }
  const shippingPaid = lamportsDeltaForAccount(tx, shippingVault);
  if (order.shippingLamports && shippingPaid < order.shippingLamports) {
    throw new functions.https.HttpsError('failed-precondition', 'Shipping payment missing or too low');
  }
  const mintedIds = extractCompressedAssetIds(tx);
  const certificateSummary = (order.items || []).map(
    (item: any, idx: number) => ({
      assetId: item.assetId,
      kind: item.kind,
      boxId: item.boxId,
      dudeIds: item.dudeIds,
      certificateIndex: item.certificateIndex,
      claimCode: item.claimCode,
      mintedAssetId: mintedIds[idx] || null,
    }),
  );

  let finalSignature = signature;
  let finalShippingPaid = shippingPaid;
  let finalCertificates = certificateSummary;
  await db.runTransaction(async (trx) => {
    const fresh = await trx.get(orderRef);
    if (!fresh.exists) throw new functions.https.HttpsError('not-found', 'Delivery order not found');
    const existing = fresh.data() as any;
    if (existing.status === 'completed' && existing.signature) {
      finalSignature = existing.signature;
      finalShippingPaid = existing.shippingPaid || shippingPaid;
      finalCertificates = existing.mintedCertificates || certificateSummary;
      return;
    }
    trx.set(
      orderRef,
      {
        status: 'completed',
        signature,
        payer: owner,
        memoDetected: Boolean(memo),
        shippingPaid,
        mintedCertificates: certificateSummary,
        burnedAssets: existing.itemIds || order.itemIds,
        finalizedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  res.json({
    recorded: true,
    signature: finalSignature,
    orderId,
    shippingPaid: finalShippingPaid,
    certificates: finalCertificates,
  });
});

export const prepareIrlClaimTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({ owner: z.string(), code: z.string() });
  const { owner, code } = schema.parse(req.body);
  if (uid !== owner) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(owner);
  const claimRef = db.doc(`claimCodes/${code}`);
  const claimDoc = await claimRef.get();
  if (!claimDoc.exists) {
    res.status(404).json({ error: 'Invalid claim code' });
    return;
  }
  const claim = claimDoc.data() as any;
  if (claim.redeemedAt || claim.redeemedSignature) {
    res.status(409).json({ error: 'Claim code already redeemed' });
    return;
  }
  const alreadyRedeemedSig = await detectClaimOnChain(code, owner).catch(() => null);
  if (alreadyRedeemedSig) {
    await claimRef.set(
      {
        redeemedAt: FieldValue.serverTimestamp(),
        redeemedBy: owner,
        redeemedSignature: alreadyRedeemedSig,
      },
      { merge: true },
    );
    res.status(409).json({ error: 'Claim already redeemed on-chain', signature: alreadyRedeemedSig });
    return;
  }
  const certificate = claim.boxId ? await findCertificateForBox(owner, claim.boxId) : null;
  if (!certificate) {
    res.status(403).json({ error: 'Blind box certificate not found in wallet' });
    return;
  }
  const certificateOwner = certificate?.ownership?.owner;
  if (certificateOwner !== owner) {
    res.status(403).json({ error: 'Certificate not found in wallet' });
    return;
  }
  const kind = getAssetKind(certificate);
  if (kind !== 'certificate') {
    res.status(400).json({ error: 'Provided asset is not a certificate' });
    return;
  }
  const certificateBoxId = getBoxIdFromAsset(certificate);
  if (!certificateBoxId) {
    res.status(400).json({ error: 'Certificate missing box reference' });
    return;
  }
  if (claim.boxId && claim.boxId !== certificateBoxId) {
    res.status(403).json({ error: 'Certificate does not match claim box' });
    return;
  }
  if (!isMonsAsset(certificate)) {
    res.status(400).json({ error: 'Certificate is outside the Mons collection' });
    return;
  }
  const certificateId = certificate.id;

  const dudeIds: number[] = claim.dudeIds || [];
  if (!dudeIds.length) {
    res.status(400).json({ error: 'Claim has no dudes assigned' });
    return;
  }
  const pending = claim.pendingAttempt;
  const nowMs = Date.now();
  const pendingExpiry = pending?.expiresAt?.toMillis ? pending.expiresAt.toMillis() : 0;
  if (pending && pendingExpiry > nowMs) {
    const message =
      pending.owner === owner
        ? 'Claim already has a pending transaction, please submit it or wait a few minutes.'
        : 'Claim is locked by another wallet right now.';
    res.status(409).json({ error: message, pending });
    return;
  }

  const attemptId = randomBytes(8).toString('hex');
  const expiresAt = Timestamp.fromMillis(nowMs + CLAIM_LOCK_WINDOW_MS);
  try {
    await db.runTransaction(async (txRef) => {
      const fresh = await txRef.get(claimRef);
      if (!fresh.exists) {
        throw new functions.https.HttpsError('not-found', 'Invalid claim code');
      }
      const data = fresh.data() as any;
      const existingPending = data.pendingAttempt;
      const existingPendingExpiry = existingPending?.expiresAt?.toMillis ? existingPending.expiresAt.toMillis() : 0;
      if (data.redeemedAt || data.redeemedSignature) {
        throw new functions.https.HttpsError('failed-precondition', 'Claim already redeemed');
      }
      if (existingPending && existingPendingExpiry > Date.now()) {
        throw new functions.https.HttpsError('failed-precondition', 'Claim already has a pending transaction');
      }
      txRef.update(claimRef, {
        pendingAttempt: {
          owner,
          attemptId,
          certificateId,
          expiresAt,
          updatedAt: FieldValue.serverTimestamp(),
        },
      });
    });
  } catch (err) {
    if (err instanceof functions.https.HttpsError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }

  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 })];
  instructions.push(memoInstruction(`claim:${code}:${attemptId}`));
  instructions.push(
    ...(await buildMintInstructions(ownerPk, dudeIds.length, 'certificate', 1, {
      boxId: claim.boxId || certificateBoxId,
      dudeIds,
    })),
  );
  const { blockhash } = await connection().getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  res.json({
    encodedTx: Buffer.from(tx.serialize()).toString('base64'),
    certificates: dudeIds,
    attemptId,
    lockExpiresAt: expiresAt.toMillis(),
    certificateId,
  });
});

export const finalizeClaimTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({ owner: z.string(), code: z.string(), signature: z.string() });
  const { owner, code, signature } = schema.parse(req.body);
  if (uid !== owner) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const claimRef = db.doc(`claimCodes/${code}`);
  const claimDoc = await claimRef.get();
  if (!claimDoc.exists) {
    res.status(404).json({ error: 'Invalid claim code' });
    return;
  }
  const claim = claimDoc.data() as any;
  if (claim.redeemedAt || claim.redeemedSignature) {
    res.status(409).json({ error: 'Claim already redeemed' });
    return;
  }

  const processed = await processClaimSignature(code, signature, owner);
  if (!processed) {
    res.status(412).json({ error: 'Claim transaction not found or invalid' });
    return;
  }

  await db.runTransaction(async (txRef) => {
    const fresh = await txRef.get(claimRef);
    if (!fresh.exists) {
      throw new functions.https.HttpsError('not-found', 'Invalid claim code');
    }
    const data = fresh.data() as any;
      if (data.redeemedAt || data.redeemedSignature) return;
      txRef.update(claimRef, {
        redeemedAt: FieldValue.serverTimestamp(),
        redeemedBy: owner,
        redeemedSignature: signature,
        redeemedCertificateId: data.pendingAttempt?.certificateId,
        pendingAttempt: FieldValue.delete(),
      });
  });

  res.json({ recorded: true, signature });
});
