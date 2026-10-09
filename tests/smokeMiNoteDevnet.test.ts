import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { AddressLookupTableAccount, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  assertMiNoteSmokeReveal, calculateMiNoteSmokeFunding, deriveMiNoteSmokeBuyer, MiNoteSmokeApi,
  parseMiNoteSmokeArgs, runMiNoteDevnetSmoke, submitMiNoteSmokeTransaction, validateMiNoteSmokeDrop,
  readMiNoteSmokePreorderFingerprint,
  verifyReceiptMint,
  acquireMiNoteSmokeRunLock, isNeverFundedMiNoteSmokeRecord, proveMiNoteSmokeBuyerUnused,
  redactMiNoteSmokeError, requireMiNoteSmokeActivationAnchor,
  type MiNoteSmokeRecord,
} from '../scripts/smoke-mi-note-devnet.ts';
import type { MiNoteDropManifest } from '../scripts/shared/miNoteDropManifest.ts';
import { parseSolanaSignInMessage, validateSolanaSignInMessage } from '../shared/walletLifecycle.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';
import { miNoteManifestFixture } from './helpers/miNoteManifest.ts';
import { prepareMiNoteDropManifest } from '../scripts/shared/miNoteDropManifest.ts';
import { DEPLOYMENT_DROPS } from '../shared/deploymentRegistry.ts';
import type { ActivationJournal } from '../scripts/shared/mintActivationJournal.ts';

const runId = '11111111-2222-4333-8444-555555555555';
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const origin = 'https://mons.shop';

function manifest(): MiNoteDropManifest {
  return {
    version: 1, dropFamily: 'mi_note_cards',
    sourcePreorder: { preorderId: 'mi_note_cards_devnet', cluster: 'devnet', collection: miNoteDropFixture().collectionMint },
    metadataBase: miNoteDropFixture().metadataBase, itemsPerPack: 2, packCount: 704, maxFigureId: 1430,
    catalogSha256: 'a'.repeat(64), preorderSnapshotSha256: 'b'.repeat(64), sha256: 'c'.repeat(64),
    excludedCardIds: Array.from({ length: 22 }, (_, index) => index + 1),
    eligibleCardIds: Array.from({ length: 1408 }, (_, index) => index + 23),
    verifiedAt: '2026-10-09T10:00:00.000Z', chain: { commitment: 'finalized', genesisHash: genesis, slot: 1, assetCount: 22 },
  };
}

function transactionFixture() {
  const authority = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const buyer = deriveMiNoteSmokeBuyer(authority, runId);
  const record: MiNoteSmokeRecord = {
    version: 1, runId, cluster: 'devnet', dropId: 'mi_note_cards_devnet', authority: authority.publicKey.toBase58(),
    buyer: buyer.buyer.publicKey.toBase58(), collection: miNoteDropFixture().collectionMint,
    mintConfig: miNoteDropFixture().boxMinterConfigPda!, operationsConfig: miNoteDropFixture().operationsConfig!.boxMinterConfigPda,
    metadataBase: miNoteDropFixture().metadataBase, manifestSha256: manifest().sha256,
    origin, createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z',
    status: 'running', stage: 'fund', fundingLamports: 350_000_000, knownAssets: [], transactions: [], shippingOrderCreated: false,
  };
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: authority.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: buyer.buyer.publicKey, lamports: 1 })],
  }).compileToV0Message());
  const events: string[] = [];
  const connection = {
    getGenesisHash: async () => { events.push('genesis'); return genesis; },
    getLatestBlockhash: async () => { events.push('blockhash'); return { blockhash: new PublicKey(new Uint8Array(32).fill(2)).toBase58(), lastValidBlockHeight: 100 }; },
    simulateTransaction: async (_tx: VersionedTransaction, options: object) => {
      events.push('simulate'); assert.deepEqual(options, { sigVerify: true, commitment: 'confirmed' });
      return { value: { err: null, unitsConsumed: 1000 } };
    },
    getFeeForMessage: async () => { events.push('fee'); return { value: 5000 }; },
    sendRawTransaction: async (bytes: Uint8Array) => {
      events.push('send');
      assert.equal(events.at(-2), 'persist:pending');
      assert.equal(record.transactions[0].status, 'pending');
      const decoded = VersionedTransaction.deserialize(bytes);
      assert.equal(record.transactions[0].signature, bs58.encode(decoded.signatures[0]));
      return record.transactions[0].signature;
    },
    getSignatureStatuses: async () => { events.push('confirm'); return { value: [{ err: null, confirmationStatus: 'finalized' }] }; },
    getBlockHeight: async () => 50,
  };
  return {
    authority, buyer, record, tx, events, connection,
    args: { connection: connection as unknown as Connection, transaction: tx, signers: [authority], label: 'test funding', record,
      approved: true, persist: () => events.push(`persist:${record.transactions.at(-1)?.status}`) },
  };
}

test('smoke CLI cannot select mainnet, arbitrary origins, insecure RPC or path-shaped recovery IDs', () => {
  assert.equal(parseMiNoteSmokeArgs([]).origin, origin);
  assert.equal(parseMiNoteSmokeArgs(['--check']).check, true);
  assert.equal(parseMiNoteSmokeArgs(['--yes', '--recover', runId]).yes, true);
  assert.equal(parseMiNoteSmokeArgs(['--recover', runId]).recoverRunId, runId);
  for (const args of [['--cluster', 'mainnet-beta'], ['--allow-mainnet'], ['--origin', 'https://evil.example'],
    ['--origin', 'https://mons.shop/path'], ['--rpc-url', 'http://localhost:8899'], ['--recover', '../keypair.json']]) {
    assert.throws(() => parseMiNoteSmokeArgs(args));
  }
});

test('buyer recovery uses a private-key HMAC and zeroes only its retained ephemeral key material', () => {
  const authority = Keypair.fromSeed(new Uint8Array(32).fill(5));
  const original = authority.secretKey;
  const first = deriveMiNoteSmokeBuyer(authority, runId);
  const second = deriveMiNoteSmokeBuyer(authority, runId);
  assert.equal(first.buyer.publicKey.toBase58(), second.buyer.publicKey.toBase58());
  const seed = createHmac('sha256', authority.secretKey).update(`mons.shop:smoke-buyer:v1\0devnet\0mi_note_cards_devnet\0${runId}`).digest();
  assert.equal(first.buyer.publicKey.toBase58(), Keypair.fromSeed(seed).publicKey.toBase58());
  const other = deriveMiNoteSmokeBuyer(authority, '11111111-2222-4333-8444-555555555556');
  assert.notEqual(first.buyer.publicKey.toBase58(), other.buyer.publicKey.toBase58());
  first.destroy();
  assert.ok(first.buyer.secretKey.every((value) => value === 0));
  assert.deepEqual(authority.secretKey, original);
  assert.ok(second.buyer.secretKey.some((value) => value !== 0));
  second.destroy(); other.destroy(); seed.fill(0); original.fill(0);
});

test('smoke drop and reveal validation preserve all 22 preorder exclusions and high card IDs', () => {
  const reviewed = manifest();
  const { treasury: _treasury, ...base } = miNoteDropFixture();
  const drop = { ...base, discountMerkleRoot: createHash('sha256').update(Buffer.alloc(32)).digest('hex'),
    inventoryManifest: { sha256: reviewed.sha256, cardIds: reviewed.eligibleCardIds },
    paymentRouting: { deliveryPaymentReceiver: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx', mintProceeds: [
      { address: 'BmV4TRHUfMZcaa6iZA4tSGf6ACGoLLsYEHcC55AEKAYf', percentage: 50 },
      { address: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM', percentage: 50 },
    ] as const },
  };
  validateMiNoteSmokeDrop(drop, reviewed);
  for (const invalid of [{ ...drop, solanaCluster: 'mainnet-beta' as const }, { ...drop, priceSol: 0.5 },
    { ...drop, stripeCheckoutEnabled: true }, { ...drop, maxSupply: 715 }, { ...drop, discountMerkleRoot: '0'.repeat(64) },
    { ...drop, paymentRouting: { ...drop.paymentRouting, mintProceeds: [
      { ...drop.paymentRouting.mintProceeds[0], percentage: 70 }, { ...drop.paymentRouting.mintProceeds[1], percentage: 30 },
    ] as const } }]) assert.throws(() => validateMiNoteSmokeDrop(invalid, reviewed));
  const signature = bs58.encode(new Uint8Array(64).fill(1));
  assert.deepEqual(assertMiNoteSmokeReveal({ signature, dudeIds: [1430, 1409] }, reviewed), { signature, ids: [1430, 1409] });
  for (const dudeIds of [[1, 1430], [1430, 1430], [1431, 1409], [1430]]) {
    assert.throws(() => assertMiNoteSmokeReveal({ signature, dudeIds }, reviewed));
  }
  assert.throws(() => assertMiNoteSmokeReveal({ signature: bs58.encode(new Uint8Array(64)), dudeIds: [1430, 1409] }, reviewed));
});

test('temporary buyer funding remains at least 0.35 and never above 0.5 devnet SOL', () => {
  assert.equal(calculateMiNoteSmokeFunding(4_500_000, 2_000_000), 350_000_000);
  assert.equal(calculateMiNoteSmokeFunding(50_000_000, 10_000_000), 430_000_000);
  assert.throws(() => calculateMiNoteSmokeFunding(80_000_000, 10_000_000), /0.5/);
  for (const value of [-1, 0, 1.5, Number.NaN]) assert.throws(() => calculateMiNoteSmokeFunding(value, 1));
});

test('the real canonical Mi Note deployment accepts default-disabled Stripe with its frozen manifest', () => {
  const reviewed = JSON.parse(readFileSync(new URL('../releases/mi-note-cards-devnet/inventory.json', import.meta.url), 'utf8')) as MiNoteDropManifest;
  const canonical = DEPLOYMENT_DROPS.mi_note_cards_devnet;
  validateMiNoteSmokeDrop(canonical, reviewed);
  const omitted = { ...canonical };
  delete omitted.stripeCheckoutEnabled;
  validateMiNoteSmokeDrop(omitted, reviewed);
  assert.throws(() => validateMiNoteSmokeDrop({ ...canonical, stripeCheckoutEnabled: true }, reviewed));
});

test('ephemeral buyer uses the existing cookie/CSRF and signed wallet API flow without shipping endpoints', async () => {
  const buyer = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const subject = `anon:${runId}`;
  const token = `mons_anon_v1.${runId}.${'s'.repeat(43)}`;
  const seen: string[] = [];
  const api = new MiNoteSmokeApi(origin, async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    seen.push(endpoint);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Origin'), origin);
    assert.equal(headers.get('X-Mons-CSRF'), '1');
    assert.equal(headers.has('Authorization'), false);
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    if (endpoint === '/api/auth/anonymous/session') return Response.json({ subject }, { status: 201,
      headers: { 'Set-Cookie': `__Host-mons_anon_v1=${token}; Path=/; Secure; HttpOnly; SameSite=Strict` } });
    assert.equal(headers.get('Cookie'), `__Host-mons_anon_v1=${token}`);
    if (endpoint === '/api/auth/solana') {
      validateSolanaSignInMessage({ message: parseSolanaSignInMessage(body.message), nowMs: Date.now(),
        originHostname: 'mons.shop', uid: subject, wallet: buyer.publicKey.toBase58() });
      assert.equal(nacl.sign.detached.verify(Buffer.from(body.message), Uint8Array.from(body.signature), buyer.publicKey.toBytes()), true);
      return Response.json({ wallet: body.wallet });
    }
    if (endpoint === '/api/boxes/reveal') return Response.json({ error: { code: 'not-found' } }, { status: 404 });
    assert.equal(endpoint, '/api/auth/anonymous/logout');
    return Response.json({ ok: true });
  });
  await api.authenticate(buyer);
  await api.probeReveal(buyer.publicKey.toBase58());
  assert.ok(!JSON.stringify(api).includes(token));
  await assert.rejects(api.call('/delivery/prepare', {}), /not permitted/);
  await api.logout();
  assert.deepEqual(seen, ['/api/auth/anonymous/session', '/api/auth/solana', '/api/boxes/reveal', '/api/auth/anonymous/logout']);
});

test('every send follows devnet verification, signing, simulation, bounded fee and durable pending record', async () => {
  const f = transactionFixture();
  try {
    const signature = await submitMiNoteSmokeTransaction(f.args);
    assert.equal(signature, f.record.transactions[0].signature);
    assert.equal(f.record.transactions[0].status, 'finalized');
    assert.deepEqual(f.events, ['genesis', 'blockhash', 'simulate', 'fee', 'persist:pending', 'send', 'confirm', 'persist:finalized']);
    assert.ok(!JSON.stringify(f.record).includes(bs58.encode(f.authority.secretKey)));
  } finally { f.buyer.destroy(); }
});

test('approval, cluster, simulation and fee failures prevent transaction submission', async () => {
  for (const variant of ['approval', 'cluster', 'simulation', 'fee'] as const) {
    const f = transactionFixture();
    try {
      if (variant === 'approval') f.args.approved = false;
      if (variant === 'cluster') f.connection.getGenesisHash = async () => 'mainnet-genesis';
      if (variant === 'simulation') f.connection.simulateTransaction = async () => ({ value: { err: 'failed', unitsConsumed: 1000 } }) as any;
      if (variant === 'fee') f.connection.getFeeForMessage = async () => ({ value: 100_001 });
      await assert.rejects(submitMiNoteSmokeTransaction(f.args));
      assert.equal(f.events.includes('send'), false);
      assert.equal(f.record.transactions.length, 0);
    } finally { f.buyer.destroy(); }
  }
});

test('uncertain send responses reconcile the recorded signature without sending a second transaction', async () => {
  const f = transactionFixture();
  let sends = 0;
  f.connection.sendRawTransaction = async () => { sends += 1; throw new Error('response lost'); };
  try {
    assert.equal(await submitMiNoteSmokeTransaction(f.args), f.record.transactions[0].signature);
    assert.equal(sends, 1);
    assert.equal(f.record.transactions[0].status, 'finalized');
  } finally { f.buyer.destroy(); }
});

test('an expired unsent signature is persisted as failed so recovery can finish', async () => {
  const f = transactionFixture();
  let sends = 0;
  f.connection.sendRawTransaction = async () => { sends += 1; throw new Error('not accepted'); };
  f.connection.getSignatureStatuses = async () => ({ value: [null] });
  f.connection.getBlockHeight = async () => 101;
  try {
    await assert.rejects(submitMiNoteSmokeTransaction(f.args), /expired without landing/);
    assert.equal(sends, 1);
    assert.equal(f.record.transactions[0].status, 'failed');
    assert.equal(f.events.at(-1), 'persist:failed');
  } finally { f.buyer.destroy(); }
});

test('the entrypoint rejects an unrelated authority before any external operation', async () => {
  await assert.rejects(runMiNoteDevnetSmoke({ authority: Keypair.generate() }), /existing Mi Note devnet authority/);
});

test('the exported smoke entrypoint loads in the existing native Node terminal workflow', () => {
  const file = new URL('../scripts/smoke-mi-note-devnet.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval',
    `const module = await import(${JSON.stringify(file)}); if (typeof module.runMiNoteDevnetSmoke !== 'function') process.exit(2);`,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('Node module adapters load and reject a non-devnet endpoint before auth or sends', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'smoke-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = new Uint8Array(64);
  bytes.set(new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx').toBytes(), 32);
  const authority = Keypair.fromSecretKey(bytes, { skipValidation: true });
  t.mock.method(Connection.prototype, 'getGenesisHash', async () => 'wrong-cluster');
  t.mock.method(Connection.prototype, 'sendRawTransaction', async () => assert.fail('no send before devnet validation'));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no HTTP request before devnet validation'));
  try {
    await assert.rejects(runMiNoteDevnetSmoke({ authority, recordDirectory: directory }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /non-devnet/);
      return true;
    });
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(path.join(directory, files[0]), 'utf8')) as MiNoteSmokeRecord;
    assert.equal(record.status, 'preflight-failed');
    assert.equal(record.diagnostic?.stage, 'preflight-cluster');
    assert.match(record.diagnostic!.message, /non-devnet/);
    assert.deepEqual(record.transactions, []);
    assert.equal(isNeverFundedMiNoteSmokeRecord(record), true);
  } finally { bytes.fill(0); }
});

test('a per-run filesystem lock rejects concurrent smoke funding or recovery', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'smoke-lock-'));
  const file = path.join(directory, `${runId}.json`);
  try {
    const release = acquireMiNoteSmokeRunLock(file);
    assert.throws(() => acquireMiNoteSmokeRunLock(file), /already locked/);
    release();
    acquireMiNoteSmokeRunLock(file)();
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a smoke lock holder cannot delete another process replacement lock', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'smoke-lock-owner-'));
  const file = path.join(directory, `${runId}.json`);
  try {
    const release = acquireMiNoteSmokeRunLock(file);
    const replacement = JSON.stringify({ pid: 99999, token: 'replacement' });
    writeFileSync(`${file}.lock`, replacement);
    release();
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), replacement);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('mismatched recovery identity is rejected without rewriting its public record', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'smoke-wrong-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = transactionFixture();
  const file = path.join(directory, `${runId}.json`);
  const source = JSON.stringify(f.record);
  writeFileSync(file, source);
  const bytes = new Uint8Array(64);
  bytes.set(new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx').toBytes(), 32);
  const authority = Keypair.fromSecretKey(bytes, { skipValidation: true });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('identity rejection must precede network access'));
  try {
    await assert.rejects(runMiNoteDevnetSmoke({ authority, recoverRunId: runId, recordDirectory: directory, yes: true }), /recovery identity/);
    assert.equal(readFileSync(file, 'utf8'), source);
    assert.deepEqual(readdirSync(directory), [`${runId}.json`]);
    for (const value of [null, false, 0, [], 'invalid']) {
      const malformed = JSON.stringify(value);
      writeFileSync(file, malformed);
      await assert.rejects(runMiNoteDevnetSmoke({ authority, recoverRunId: runId, recordDirectory: directory, yes: true }), /recovery record/);
      assert.equal(readFileSync(file, 'utf8'), malformed);
    }
  } finally { bytes.fill(0); f.buyer.destroy(); }
});

test('only a never-funded record may resume a fresh purchase for the same run', () => {
  const f = transactionFixture();
  try {
    const record = { ...f.record, status: 'preflight-failed' as const };
    assert.equal(isNeverFundedMiNoteSmokeRecord(record), true);
    assert.equal(isNeverFundedMiNoteSmokeRecord({ ...record, status: 'passed' }), false);
    assert.equal(isNeverFundedMiNoteSmokeRecord({ ...record, knownAssets: [f.authority.publicKey.toBase58()] }), false);
    assert.equal(isNeverFundedMiNoteSmokeRecord({ ...record, transactions: [{ label: 'fund buyer', signature: 'signature',
      blockhash: 'blockhash', lastValidBlockHeight: 1, status: 'failed', simulationUnits: 1, feeLamports: 1 }] }), false);
  } finally { f.buyer.destroy(); }
});

test('unused-buyer proof checks account, balance and history at both finalized and confirmed commitments', async () => {
  const buyer = Keypair.generate().publicKey;
  const commitments: string[] = [];
  const connection = {
    getAccountInfo: async (_key: PublicKey, commitment: string) => { commitments.push(commitment); return null; },
    getBalance: async () => 0,
    getSignaturesForAddress: async () => [],
  };
  await proveMiNoteSmokeBuyerUnused(connection as any, buyer);
  assert.deepEqual(commitments, ['finalized', 'confirmed']);
  for (const changed of [
    { getAccountInfo: async () => ({ lamports: 0 }) },
    { getBalance: async () => 1 },
    { getSignaturesForAddress: async () => [{ signature: 'prior' }] },
  ]) await assert.rejects(proveMiNoteSmokeBuyerUnused({ ...connection, ...changed } as any, buyer), /refusing a fresh purchase/);
});

test('missing-record recovery requires the matching active activation anchor and terminal signed attempt', () => {
  const journal = JSON.parse(readFileSync(new URL('../releases/mi-note-cards-devnet/activation.json', import.meta.url), 'utf8')) as ActivationJournal;
  const anchor = { ...journal, smoke: { runId, status: 'recovery-required' as const } };
  assert.equal(requireMiNoteSmokeActivationAnchor(anchor, runId), journal.attempts.at(-1)!.signature);
  for (const changed of [{ status: 'prepared' }, { authority: PublicKey.default.toBase58() },
    { smoke: { runId: '11111111-2222-4333-8444-555555555556', status: 'recovery-required' } },
    { attempts: journal.attempts.map((attempt) => ({ ...attempt, status: 'signed' })) }]) {
    assert.throws(() => requireMiNoteSmokeActivationAnchor({ ...anchor, ...changed } as ActivationJournal, runId), /not anchored/);
  }
});

test('public preflight diagnostics keep concrete errors while removing RPC and session secrets', () => {
  const secret = 'sensitive-api-key';
  const token = `mons_anon_v1.${runId}.${'s'.repeat(43)}`;
  const safe = redactMiNoteSmokeError(new Error(`Request failed https://devnet.helius-rpc.com/?api-key=${secret}; key=${secret}; ${token}`),
    `https://devnet.helius-rpc.com/?api-key=${secret}`);
  assert.match(safe, /Request failed/);
  assert.match(safe, /devnet.helius-rpc.com/);
  assert.equal(safe.includes(secret), false);
  assert.equal(safe.includes(token), false);
  assert.equal(safe.includes('?api-key='), false);
});

async function fingerprintFixture() {
  const source = miNoteManifestFixture();
  const assets = Array.from({ length: 22 }, (_, index) => ({ id: index + 1,
    address: new PublicKey(new Uint8Array(32).fill(index + 1)).toBase58() }));
  source.snapshot.orders = Array.from({ length: 8 }, (_, index) => ({
    orderId: `order-${index}`, preorderId: source.config.preorderId, cluster: source.config.cluster,
    collection: source.config.collection, status: 'succeeded', revision: 3,
    cardIds: assets.slice(index * 3, index * 3 + 3).map(({ id }) => id), assets: assets.slice(index * 3, index * 3 + 3),
  }));
  source.snapshot.claims = assets.map(({ id }) => ({ id, orderId: `order-${Math.floor((id - 1) / 3)}`,
    cluster: source.config.cluster, collection: source.config.collection }));
  const catalogText = JSON.stringify({ ethereumCollections: [{ tokens: Array.from({ length: 1430 }, (_, index) => ({
    clean_card_id: index + 1, name: `Artwork ${index + 1}`,
  })).filter(({ clean_card_id }) => clean_card_id < 1401 || clean_card_id > 1408) }],
  specialCards: Array.from({ length: 8 }, (_, index) => ({ clean_card_id: index + 1401, name: `Special ${index}` })) });
  const reviewed = await prepareMiNoteDropManifest(source.config.preorderId, {
    ...source.dependencies, catalogText: () => catalogText,
    chain: async () => ({ ...source.chain, assets: assets.map((asset) => ({ ...asset, name: `Preorder #${asset.id}`,
      collection: source.config.collection, uri: `${source.config.metadataBase}${asset.id}.json` })) }),
  });
  const string = (value: string) => {
    const bytes = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const data = (id: number, name = `Preorder #${id}`, uri = `${source.config.metadataBase}${id}.json`) => Buffer.concat([
    Buffer.from([1]), new PublicKey(new Uint8Array(32).fill(88)).toBuffer(), Buffer.from([2]),
    new PublicKey(source.config.collection).toBuffer(), string(name), string(uri), Buffer.from([0]),
  ]);
  const accounts = new Map(assets.map((asset) => [asset.address, { data: data(asset.id), executable: false,
    owner: new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'), lamports: 1, rentEpoch: 0 }]));
  let scanned = false;
  let directReads = 0;
  const connection = {
    getGenesisHash: async () => source.chain.genesisHash,
    getProgramAccounts: async () => { scanned = true; return assets.slice(0, 18); },
    getMultipleAccountsInfoAndContext: async (addresses: PublicKey[], options: any) => {
      directReads += 1;
      assert.deepEqual(addresses.map((address) => address.toBase58()), assets.map(({ address }) => address));
      assert.equal(options.commitment, 'finalized');
      assert.equal(options.minContextSlot, reviewed.chain.slot);
      return { context: { slot: reviewed.chain.slot + 1 }, value: addresses.map((address) => accounts.get(address.toBase58())!) };
    },
  };
  const drop = { ...miNoteDropFixture(), inventoryManifest: { sha256: reviewed.sha256, cardIds: reviewed.eligibleCardIds } };
  const read = () => readMiNoteSmokePreorderFingerprint(connection as unknown as Connection, drop, reviewed,
    { query: source.dependencies.query, catalogText });
  return { source, assets, reviewed, accounts, connection, data, read, observations: () => ({ scanned, directReads }) };
}

test('preorder fingerprint directly reads all 22 claimed assets despite an 18-item collection index', async () => {
  const f = await fingerprintFixture();
  const before = await f.read();
  assert.equal(before.count, 22);
  assert.equal(before.sha256, createHash('sha256').update(JSON.stringify(f.assets.map(({ id, address }) => [
    id, address, createHash('sha256').update(f.accounts.get(address)!.data).digest('hex'),
  ]))).digest('hex'));
  assert.deepEqual(await f.read(), before);
  assert.deepEqual(f.observations(), { scanned: false, directReads: 2 });
  f.accounts.get(f.assets[0].address)!.data[1] ^= 1;
  assert.notEqual((await f.read()).sha256, before.sha256);
});

test('direct preorder fingerprint rejects missing, migrated, malformed or wrong-program claimed assets', async () => {
  for (const corruption of ['missing', 'name', 'uri', 'type', 'owner', 'executable'] as const) {
    const f = await fingerprintFixture();
    const address = f.assets[0].address;
    const account = f.accounts.get(address)!;
    if (corruption === 'missing') f.accounts.delete(address);
    if (corruption === 'name') account.data = f.data(1, 'Card #1');
    if (corruption === 'uri') account.data = f.data(1, 'Preorder #1', `${f.reviewed.metadataBase}/f1.json`);
    if (corruption === 'type') account.data[0] = 0;
    if (corruption === 'owner') account.owner = PublicKey.default;
    if (corruption === 'executable') account.executable = true;
    await assert.rejects(f.read(), /claimed preorder account/);
  }
});

test('direct preorder fingerprint rejects stale slots and source changes before or during account reads', async () => {
  const stale = await fingerprintFixture();
  const original = stale.connection.getMultipleAccountsInfoAndContext;
  stale.connection.getMultipleAccountsInfoAndContext = async (keys, options) => ({
    ...await original(keys, options), context: { slot: stale.reviewed.chain.slot - 1 },
  });
  await assert.rejects(stale.read(), /stale or incomplete/);
  const changed = await fingerprintFixture();
  changed.source.snapshot.orders[0].revision += 1;
  await assert.rejects(changed.read(), /exclusions changed/);
  const during = await fingerprintFixture();
  const direct = during.connection.getMultipleAccountsInfoAndContext;
  during.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {
    const result = await direct(keys, options);
    during.source.snapshot.orders[0].revision += 1;
    return result;
  };
  await assert.rejects(during.read(), /source changed during/);
});

function receiptTransactionFixture(useLookupTable = false) {
  const authority = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
  const collection = new PublicKey('65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv');
  const bubblegum = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
  const wrong = new PublicKey(new Uint8Array(32).fill(23));
  const tree = new PublicKey(new Uint8Array(32).fill(24));
  const outer = new TransactionInstruction({
    programId: new PublicKey('8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6'),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: bubblegum, isSigner: false, isWritable: false },
      { pubkey: wrong, isSigner: false, isWritable: false },
    ], data: Buffer.from([1]),
  });
  const lookup = new AddressLookupTableAccount({ key: new PublicKey(new Uint8Array(32).fill(25)), state: {
    deactivationSlot: 0xffff_ffff_ffff_ffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
    addresses: [collection, tree, bubblegum],
  } });
  const message = new TransactionMessage({ payerKey: authority, recentBlockhash: PublicKey.default.toBase58(), instructions: [outer] })
    .compileToV0Message(useLookupTable ? [lookup] : []);
  const loadedAddresses = useLookupTable ? {
    writable: message.addressTableLookups.flatMap((entry) => Array.from(entry.writableIndexes, (index) => lookup.state.addresses[index])),
    readonly: message.addressTableLookups.flatMap((entry) => Array.from(entry.readonlyIndexes, (index) => lookup.state.addresses[index])),
  } : { writable: [], readonly: [] };
  const keys = [...message.staticAccountKeys, ...loadedAddresses.writable, ...loadedAddresses.readonly];
  const index = (address: PublicKey) => keys.findIndex((key) => key.equals(address));
  const string = (value: string) => {
    const encoded = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(encoded.length);
    return Buffer.concat([length, encoded]);
  };
  const uris = ['rb1', 'rf1430', 'rf1409'].map((stem) => `${miNoteDropFixture().metadataBase}/${stem}.json`);
  const instructions = uris.map((uri, i) => ({
    programIdIndex: index(bubblegum), accounts: [index(tree), index(authority), index(authority), index(authority),
      index(authority), index(authority), index(tree), index(collection)],
    data: bs58.encode(Buffer.concat([
      Buffer.from([120, 121, 23, 146, 173, 110, 199, 205]),
      string(i === 0 ? 'receipt · pack 1' : `receipt · card ${i === 1 ? 1430 : 1409}`), string(''), string(uri),
      Buffer.from([0, 0, 0, 1, 1, 0]), Buffer.alloc(4), Buffer.from([1]), collection.toBuffer(), Buffer.from([0, 0]),
    ])),
  }));
  const result = { slot: 100, transaction: { message, signatures: [bs58.encode(new Uint8Array(64).fill(4))] },
    meta: { err: null, loadedAddresses, innerInstructions: [{ index: 0, instructions }], logMessages: [] as string[] } };
  const connection = { getTransaction: async (_signature: string, options: unknown) => {
    assert.deepEqual(options, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    return result;
  } } as unknown as Connection;
  return { result, connection, authority, uris, wrong: index(wrong), instructions };
}

test('receipt verification decodes base58 Bubblegum CPI metadata instead of searching JSON plaintext', async () => {
  for (const useLookupTable of [false, true]) {
    const f = receiptTransactionFixture(useLookupTable);
    for (const uri of f.uris) assert.equal(JSON.stringify(f.result).includes(uri), false);
    await verifyReceiptMint(f.connection, f.result.transaction.signatures[0], f.authority, f.uris);
  }
});

test('receipt verification rejects wrong owner, delegate, collection, program, URI set and failed transactions', async () => {
  for (const corruption of ['owner', 'delegate', 'collection', 'program', 'uri', 'failed', 'no-cpi'] as const) {
    const f = receiptTransactionFixture();
    if (corruption === 'owner') f.instructions[0].accounts[4] = f.wrong;
    if (corruption === 'delegate') f.instructions[0].accounts[5] = f.wrong;
    if (corruption === 'collection') f.instructions[0].accounts[7] = f.wrong;
    if (corruption === 'program') f.instructions[0].programIdIndex = f.wrong;
    if (corruption === 'uri') f.uris[0] = `${miNoteDropFixture().metadataBase}/rb2.json`;
    if (corruption === 'failed') f.result.meta.err = { InstructionError: [0, 'Custom'] } as any;
    if (corruption === 'no-cpi') {
      f.result.meta.innerInstructions = [];
      f.result.meta.logMessages = f.uris;
    }
    await assert.rejects(verifyReceiptMint(f.connection, f.result.transaction.signatures[0], f.authority, f.uris));
  }
});
