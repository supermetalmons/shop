import * as admin from 'firebase-admin';
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
import { randomInt } from 'crypto';
import { z } from 'zod';

admin.initializeApp();
const db = admin.firestore();
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function maybeHandleCors(req: functions.Request, res: functions.Response) {
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

const cluster = (process.env.SOLANA_CLUSTER || 'devnet') as 'devnet' | 'testnet' | 'mainnet-beta';
const totalSupply = cluster === 'mainnet-beta' ? prodSupply : devSupply;
const totalDudes = totalSupply * DUDES_PER_BOX;
const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl(cluster === 'testnet' ? 'testnet' : 'devnet');

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

function parseSignature(sig: number[] | string) {
  if (typeof sig === 'string') return bs58.decode(sig);
  return Uint8Array.from(sig);
}

function buildMetadata(kind: 'box' | 'dude' | 'certificate', index: number, extra?: { boxId?: string; dudeId?: number }): MetadataArgs {
  const nameMap = {
    box: `mons blind box #${index}`,
    dude: `mons dude #${extra?.dudeId ?? index}`,
    certificate: `mons authenticity #${index}`,
  } as const;
  const uriSuffix = kind === 'box' ? 'box.json' : kind === 'dude' ? 'dude.json' : 'certificate.json';
  const attrs = [
    { trait_type: 'type', value: kind },
    extra?.boxId ? { trait_type: 'box_id', value: extra.boxId } : null,
    extra?.dudeId ? { trait_type: 'dude_id', value: `${extra.dudeId}` } : null,
  ].filter(Boolean) as { trait_type: string; value: string }[];

  return {
    name: nameMap[kind],
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
    const dudeId = extra?.dudeIds ? extra.dudeIds[i] : undefined;
    const metadataArgs = buildMetadata(kind, startIndex + i, { boxId: extra?.boxId, dudeId });
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

async function getMintedCount(): Promise<number> {
  const snap = await db.doc('meta/stats').get();
  return snap.exists ? Number((snap.data() as any).minted || 0) : 0;
}

async function incrementMinted(by: number) {
  const ref = db.doc('meta/stats');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number((snap.data() as any).minted || 0) : 0;
    if (current + by > totalSupply) {
      throw new functions.https.HttpsError('failed-precondition', 'Mint supply exceeded');
    }
    tx.set(ref, { minted: current + by, total: totalSupply }, { merge: true });
  });
}

async function fetchAssetsOwned(owner: string) {
  const helius = process.env.HELIUS_API_KEY;
  const url = `https://api.helius.xyz/v0/addresses/${owner}/nfts?api-key=${helius}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Helius assets error ${res.status}`);
  return await res.json();
}

async function fetchAssetProof(assetId: string) {
  const helius = process.env.HELIUS_API_KEY;
  const res = await fetch(`https://api.helius.xyz/v0/assets/${assetId}/proof?api-key=${helius}`);
  if (!res.ok) throw new Error(`Helius proof error ${res.status}`);
  return await res.json();
}

async function fetchAsset(assetId: string) {
  const helius = process.env.HELIUS_API_KEY;
  const res = await fetch(`https://api.helius.xyz/v0/assets?ids[]=${assetId}&api-key=${helius}`);
  if (!res.ok) throw new Error(`Helius asset error ${res.status}`);
  const json = await res.json();
  return json[0];
}

async function createBurnIx(assetId: string, owner: PublicKey) {
  const [asset, proof] = await Promise.all([fetchAsset(assetId), fetchAssetProof(assetId)]);
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
    tx.set(ref, { dudeIds: chosen, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return chosen;
  });
}

function buildTx(instructions: TransactionInstruction[], payer: PublicKey, recentBlockhash: string) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([treeAuthority(), cosigner()]);
  return tx;
}

function transformInventoryItem(asset: any) {
  const kindAttr = asset?.content?.metadata?.attributes?.find((a: any) => a.trait_type === 'type');
  const kind = (kindAttr?.value || 'box') as 'box' | 'dude' | 'certificate';
  return {
    id: asset.id,
    name: asset.content?.metadata?.name || asset.id,
    kind,
    image: asset.content?.links?.image,
    attributes: asset.content?.metadata?.attributes || [],
    status: asset.compression?.compressed ? 'minted' : 'unknown',
  };
}

function shippingLamports(country: string, items: number) {
  const base = country.toLowerCase().includes('us') ? 0.15 : 0.32;
  const multiplier = Math.max(1, items * 0.35);
  return Math.round(base * multiplier * LAMPORTS_PER_SOL);
}

async function verifyAuth(req: functions.Request) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) throw new functions.https.HttpsError('unauthenticated', 'Missing auth token');
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded.uid;
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

  const userRecord = await admin.auth().getUserByEmail(`${wallet}@mons.shop`).catch(() => null);
  if (!userRecord) {
    await admin.auth().createUser({ uid: wallet, email: `${wallet}@mons.shop` }).catch(() => undefined);
  }
  const customToken = await admin.auth().createCustomToken(wallet);
  const profileRef = db.doc(`profiles/${wallet}`);
  const snap = await profileRef.get();
  const addressesSnap = await db.collection(`profiles/${wallet}/addresses`).get();
  const addresses = addressesSnap.docs.map((doc) => doc.data());
  const profile = snap.exists ? snap.data() : { wallet };
  if (!snap.exists) await profileRef.set(profile);
  res.json({ customToken, profile: { ...profile, addresses } });
});

export const stats = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  const minted = await getMintedCount();
  res.json({ minted, total: totalSupply, remaining: Math.max(0, totalSupply - minted) });
});

export const inventory = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  const owner = (req.query.owner as string) || '';
  if (!owner) {
    res.status(400).json({ error: 'owner required' });
    return;
  }
  const assets = await fetchAssetsOwned(owner);
  const items = (assets || []).map(transformInventoryItem);
  res.json(items);
});

export const saveAddress = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({ encrypted: z.string(), country: z.string(), label: z.string().default('Home') });
  const body = schema.parse(req.body);
  const id = db.collection('tmp').doc().id;
  const hint = body.encrypted.slice(0, 6) + '…';
  const addressRef = db.doc(`profiles/${uid}/addresses/${id}`);
  await addressRef.set({ ...body, id, hint, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ id, label: body.label, country: body.country, encrypted: body.encrypted, hint });
});

export const prepareMintTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const schema = z.object({ owner: z.string(), quantity: z.number().min(1).max(20) });
  const { owner, quantity } = schema.parse(req.body);
  const ownerPk = new PublicKey(owner);
  await incrementMinted(quantity);
  const conn = connection();
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })];
  const mintedSoFar = await getMintedCount();
  instructions.push(...(await buildMintInstructions(ownerPk, quantity, 'box', mintedSoFar - quantity + 1)));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  res.json({ encodedTx: Buffer.from(tx.serialize()).toString('base64') });
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
  const dudeIds = await assignDudes(boxAssetId);
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 })];
  try {
    instructions.push(await createBurnIx(boxAssetId, ownerPk));
  } catch (err) {
    instructions.push(memoInstruction(`open-box:${boxAssetId}`));
  }
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
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 })];
  for (let i = 0; i < itemIds.length; i += 1) {
    const id = itemIds[i];
    try {
      instructions.push(await createBurnIx(id, ownerPk));
    } catch (err) {
      instructions.push(memoInstruction(`burn:${id}`));
    }
    instructions.push(...(await buildMintInstructions(ownerPk, 1, 'certificate', i + 1, { boxId: id })));
  }
  const addressSnap = await db.doc(`profiles/${uid}/addresses/${addressId}`).get();
  const addressData = addressSnap.data();
  const deliveryPrice = shippingLamports(addressData?.country || 'unknown', itemIds.length);
  instructions.unshift(SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: shippingVault, lamports: deliveryPrice }));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  res.json({ encodedTx: Buffer.from(tx.serialize()).toString('base64'), deliveryLamports: deliveryPrice });
});

export const prepareIrlClaimTx = functions.https.onRequest(async (req, res) => {
  if (maybeHandleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const uid = await verifyAuth(req);
  const schema = z.object({ owner: z.string(), code: z.string(), blindBoxCertificateId: z.string() });
  const { owner, code, blindBoxCertificateId } = schema.parse(req.body);
  if (uid !== owner) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(owner);
  const claimDoc = await db.doc(`claimCodes/${code}`).get();
  if (!claimDoc.exists) {
    res.status(404).json({ error: 'Invalid claim code' });
    return;
  }
  const claim = claimDoc.data() as any;
  const assets = await fetchAssetsOwned(owner);
  const ownsCertificate = (assets || []).some((a: any) => a.id === blindBoxCertificateId);
  if (!ownsCertificate) {
    res.status(403).json({ error: 'Certificate not found in wallet' });
    return;
  }

  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 })];
  instructions.push(memoInstruction(`claim:${code}`));
  const dudeIds: number[] = claim.dudeIds || [];
  instructions.push(...(await buildMintInstructions(ownerPk, dudeIds.length, 'certificate', dudeIds[0] || 1, { boxId: claim.boxId, dudeIds })));
  const { blockhash } = await connection().getLatestBlockhash('confirmed');
  const tx = buildTx(instructions, ownerPk, blockhash);
  res.json({ encodedTx: Buffer.from(tx.serialize()).toString('base64'), certificates: dudeIds });
});
