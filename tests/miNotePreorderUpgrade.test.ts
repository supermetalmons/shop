import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo } from '@solana/web3.js';
import { getPreorderConfig, PREORDER_PAYMENT_RECIPIENTS } from '../shared/preorders.ts';
import type { DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';
import { NEW_PREORDER_COLLECTION } from '../scripts/newPreorderCollections/mi_note_cards.ts';
import { preparePreorderCollectionConfig } from '../scripts/shared/preorderCollectionConfig.ts';
import { MI_NOTE_CLUSTER_GENESIS, prepareMiNoteDropManifest, type MiNotePreorderSnapshot } from '../scripts/shared/miNoteDropManifest.ts';
import {
  buildMiNotePreorderUpdateInstruction, buildMiNoteUpgradeTransaction, createMiNoteUpgradeManifest,
  inspectMiNoteUpgradeAsset, readMiNoteUpgradeJournal, validateMiNoteUpgradeAttempt, validateMiNoteUpgradeManifest,
  validateMiNoteUpgradeSource, validateMiNoteUpgradeTargetMetadata, writeMiNoteUpgradeJson,
  type MiNoteUpgradeAttempt,
} from '../scripts/shared/miNotePreorderUpgrade.ts';
import { parseMiNotePreorderUpgradeArgs, runMiNotePreorderUpgrade, type MiNoteUpgradeDependencies } from '../scripts/upgrade-mi-note-preorders.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';
import { acquireDeploymentRegistryMutationLock } from '../scripts/shared/deploymentRegistry.ts';

function u32(value: number) { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; }
function string(value: string) { const data = Buffer.from(value); return Buffer.concat([u32(data.length), data]); }
function account(data: Buffer, owner = MPL_CORE_PROGRAM_ADDRESS, lamports = 1_000_000): AccountInfo<Buffer> {
  return { data, owner: new PublicKey(owner), executable: false, lamports, rentEpoch: 0 };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mi-note-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payer = Keypair.generate();
  const holder = Keypair.generate().publicKey;
  const config = getPreorderConfig('mi_note_cards_devnet')!;
  const previousAuthority = config.authority;
  Object.assign(config, { authority: payer.publicKey.toBase58() });
  t.after(() => Object.assign(config, { authority: previousAuthority }));
  const catalogText = readFileSync(new URL('../mi_note_cards.json', import.meta.url), 'utf8');
  const claims = Array.from({ length: 22 }, (_, index) => ({ id: index + 1, address: new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58() }));
  const snapshot: MiNotePreorderSnapshot = {
    orders: Array.from({ length: 8 }, (_, index) => ({ orderId: `order-${index}`, preorderId: config.preorderId,
      cluster: config.cluster, collection: config.collection, status: 'succeeded', revision: 3,
      cardIds: claims.slice(index * 3, index * 3 + 3).map(asset => asset.id), assets: claims.slice(index * 3, index * 3 + 3) })),
    claims: claims.map(asset => ({ id: asset.id, orderId: `order-${Math.floor((asset.id - 1) / 3)}`, cluster: config.cluster, collection: config.collection })),
  };
  const inventory = await prepareMiNoteDropManifest(config.preorderId, {
    query: () => [{ snapshot_json: JSON.stringify(snapshot) }], catalogText: () => catalogText,
    chain: async () => ({ genesisHash: MI_NOTE_CLUSTER_GENESIS.devnet, slot: 1000,
      assets: claims.map(asset => ({ ...asset, collection: config.collection, name: `Preorder #${asset.id}`, uri: `${config.metadataBase}${asset.id}.json` })) }),
    now: () => new Date('2026-10-10T00:00:00Z'),
  });
  const { treasury: _treasury, ...base } = miNoteDropFixture();
  const drop: DeploymentRegistryDrop = { ...base, maxSupply: inventory.packCount, inventoryManifest: { sha256: inventory.sha256, cardIds: inventory.eligibleCardIds },
    receiptsTreeMaxDepth: 14, receiptsTreeCanopyDepth: 0, deliveryLookupTable: Keypair.generate().publicKey.toBase58(),
    paymentRouting: { deliveryPaymentReceiver: config.authority,
      mintProceeds: [{ address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 }, { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 }] } };
  const collectionConfig = preparePreorderCollectionConfig({ ...NEW_PREORDER_COLLECTION,
    collectionId: config.preorderId, isMainnet: false, authority: config.authority }, config.preorderId);
  const deployment = { version: 1, finalizedSlot: 1000, transactions: [], collectionDelegates: [config.authority, drop.boxMinterConfigPda, drop.operationsConfig!.boxMinterConfigPda],
    drop, plan: { version: 1, dropId: drop.dropId, cluster: drop.solanaCluster, authority: config.authority, programId: drop.boxMinterProgramId,
      collection: drop.collectionMint, manifestSha256: inventory.sha256,
      mintConfig: { configId: drop.dropId, boxMinterConfigPda: drop.boxMinterConfigPda, maxSupply: drop.maxSupply, itemsPerBox: 0 },
      operationsConfig: { ...drop.operationsConfig, itemsPerBox: 2 } } };
  const sourceArgs = { config, drop, inventory, collectionConfig, deployment, snapshot, catalogText,
    targetMetadataSha256: 'b'.repeat(64), inventoryGeneration: randomUUID(), available: inventory.eligibleCardIds.length, assigned: 0 };
  const source = await validateMiNoteUpgradeSource(sourceArgs);
  const programs = 'a'.repeat(64);
  const manifest = createMiNoteUpgradeManifest(source, programs, 1000, new Date('2026-10-10T00:00:00Z'));
  const manifestPath = path.join(root, 'manifest.json');
  writeMiNoteUpgradeJson(manifestPath, manifest);
  const journalPath = path.join(root, 'journal.json');
  const assetBytes = (id: number, converted = false, owner = holder, sequence: bigint | null = null) => {
    const asset = source.assets.find(asset => asset.id === id)!;
    const metadata = converted ? asset.target : asset.original;
    const seq = sequence === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), (() => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(sequence); return bytes; })()]);
    return Buffer.concat([Buffer.from([1]), owner.toBuffer(), Buffer.from([2]), new PublicKey(config.collection).toBuffer(), string(metadata.name), string(metadata.uri), seq]);
  };
  const accounts = new Map<string, AccountInfo<Buffer>>([
    ...claims.map(asset => [asset.address, account(assetBytes(asset.id))] as const),
    [config.collection, account(Buffer.concat([Buffer.from([5]), payer.publicKey.toBuffer(), string(collectionConfig.collectionMetadata.name), string(collectionConfig.collectionMetadataUri), u32(22), u32(22)]))],
    [config.authority, account(Buffer.alloc(0), SystemProgram.programId.toBase58(), 10_000_000_000)],
  ]);
  const state = { slot: 1000, height: 10, hash: 50, prompts: 0, simulations: 0, sourceReads: 0,
    failure: '' as '' | 'before' | 'after' | 'failed' | 'interrupt', failSource: false, corruptSimulation: false,
    programs, sends: [] as string[], onPrompt: undefined as (() => void) | undefined, onConfirm: undefined as (() => void) | undefined,
    repeatHash: undefined as { blockhash: string; lastValidBlockHeight: number } | undefined };
  const statuses = new Map<string, { slot: number; err: unknown; confirmations: null; confirmationStatus: 'finalized' }>();
  const blockhashes = new Map<string, number>();
  const connection = new Connection('https://fixture.invalid');
  t.mock.method(connection, 'getGenesisHash', async () => MI_NOTE_CLUSTER_GENESIS.devnet);
  t.mock.method(connection, 'getMultipleAccountsInfoAndContext', async (keys, options) => {
    assert.equal(typeof options, 'object');
    assert.ok(typeof options === 'object' && (options.minContextSlot ?? 0) <= state.slot, 'never use the processed signature context as a finalized read floor');
    return { context: { slot: state.slot }, value: keys.map(key => accounts.get(key.toBase58()) ?? null) };
  });
  t.mock.method(connection, 'getLatestBlockhashAndContext', async options => {
    assert.deepEqual(options, { commitment: 'finalized', minContextSlot: state.slot });
    const value = state.repeatHash ?? { blockhash: new PublicKey(new Uint8Array(32).fill(state.hash++)).toBase58(), lastValidBlockHeight: state.height + 100 };
    blockhashes.set(value.blockhash, value.lastValidBlockHeight);
    return { context: { slot: state.slot }, value };
  });
  t.mock.method(connection, 'getBlockHeight', async options => {
    assert.deepEqual(options, { commitment: 'finalized', minContextSlot: state.slot }); return state.height;
  });
  t.mock.method(connection, 'getEpochInfo', async () => ({ epoch: 1, slotIndex: 1, slotsInEpoch: 10000, absoluteSlot: state.slot, blockHeight: state.height }));
  t.mock.method(connection, 'isBlockhashValid', async hash => ({ context: { slot: state.slot }, value: state.height <= (blockhashes.get(hash) ?? 0) }));
  t.mock.method(connection, 'getSignatureStatuses', async signatures => ({ context: { slot: state.slot + 30 }, value: signatures.map(signature => statuses.get(signature) ?? null) }));
  t.mock.method(connection, 'getFeeForMessage', async () => ({ context: { slot: state.slot }, value: 5000 }));
  const effects = (transaction: VersionedTransaction) => {
    const result = new Map<string, AccountInfo<Buffer>>(); let rentDelta = 0;
    for (const instruction of TransactionMessage.decompile(transaction.message).instructions.slice(1)) {
      const address = instruction.keys[0].pubkey.toBase58();
      const asset = source.assets.find(asset => asset.address === address)!;
      const before = accounts.get(address)!;
      const inspected = inspectMiNoteUpgradeAsset(before, asset, source);
      const data = assetBytes(asset.id, true, new PublicKey(inspected.owner), inspected.sequence === null ? null : inspected.sequence + 1n);
      const lamports = before.lamports + (data.length - before.data.length) * 5080;
      rentDelta += lamports - before.lamports;
      if (state.corruptSimulation) data.fill(0, 1, 33);
      result.set(address, { ...before, data, lamports });
    }
    const payerAccount = accounts.get(config.authority)!;
    result.set(config.authority, { ...payerAccount, lamports: payerAccount.lamports - 5000 - rentDelta });
    return result;
  };
  t.mock.method(connection, 'simulateTransaction', async (transaction: VersionedTransaction, options) => {
    state.simulations += 1;
    const updated = effects(transaction);
    return { context: { slot: state.slot }, value: { err: null, unitsConsumed: 45000,
      accounts: options!.accounts!.addresses.map(address => { const entry = updated.get(address) ?? accounts.get(address)!;
        return { ...entry, owner: entry.owner.toBase58(), data: [entry.data.toString('base64'), 'base64'] }; }) } };
  });
  t.mock.method(connection, 'sendRawTransaction', async bytes => {
    const transaction = VersionedTransaction.deserialize(bytes);
    const signature = bs58.encode(transaction.signatures[0]);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(journal.attempts.at(-1).signature, signature);
    assert.equal(journal.attempts.at(-1).transactionBase64, Buffer.from(bytes).toString('base64'));
    state.sends.push(Buffer.from(bytes).toString('base64'));
    const failure = state.failure; state.failure = '';
    if (failure === 'before') throw new Error('transport lost before landing');
    state.slot += 1;
    if (failure !== 'failed') for (const [key, value] of effects(transaction)) accounts.set(key, value);
    statuses.set(signature, { slot: state.slot, err: failure === 'failed' ? { InstructionError: [1, 'Custom'] } : null, confirmations: null, confirmationStatus: 'finalized' });
    if (failure === 'interrupt') state.failSource = true;
    if (failure === 'after') throw new Error('transport lost after landing');
    return signature;
  });
  t.mock.method(connection, 'confirmTransaction', async strategy => {
    const signature = typeof strategy === 'string' ? strategy : strategy.signature;
    return { context: { slot: state.slot }, value: { err: statuses.get(signature)?.err ?? null } };
  });
  const dependencies: Partial<MiNoteUpgradeDependencies> = {
    loadSource: async () => {
      state.sourceReads += 1;
      if (state.failSource) { state.failSource = false; throw new Error('interrupted after landing'); }
      return validateMiNoteUpgradeSource(sourceArgs);
    },
    createConnection: () => connection, verifyPrograms: async () => state.programs, verifyResources: async () => {},
    now: () => new Date('2026-10-10T00:00:00Z'), log: () => {},
    confirm: async () => { state.onConfirm?.(); return true; },
    promptPrivateKey: async () => { state.prompts += 1; state.onPrompt?.(); return bs58.encode(payer.secretKey); },
  };
  const options = { preorderId: config.preorderId, manifestPath, root, write: false, check: false, yes: false, allowMainnet: false };
  const run = (changes: Partial<typeof options> = {}) => runMiNotePreorderUpgrade({ ...options, ...changes }, dependencies);
  return { root, source, sourceArgs, manifest, manifestPath, journalPath, payer, holder, accounts, assetBytes, state, connection, dependencies, options, run };
}

test('upgrade CLI has explicit mutually exclusive modes and mainnet writes cannot be implicit', async t => {
  assert.equal(parseMiNotePreorderUpgradeArgs(['mi_note_cards_devnet', '--manifest', 'manifest.json']).write, false);
  assert.equal(parseMiNotePreorderUpgradeArgs(['mi_note_cards', '--manifest', 'manifest.json', '--write', '--allow-mainnet']).allowMainnet, true);
  for (const args of [[], ['unknown', '--manifest', 'x'], ['mi_note_cards_devnet'],
    ['mi_note_cards_devnet', '--prepare', 'x', '--write'], ['mi_note_cards_devnet', '--manifest', 'x', '--check', '--write'],
    ['mi_note_cards_devnet', '--manifest', 'x', '--yes'], ['mi_note_cards_devnet', '--prepare', 'x', '--manifest', 'y']]) assert.throws(() => parseMiNotePreorderUpgradeArgs(args));
  const f = await fixture(t);
  await assert.rejects(f.run({ preorderId: 'mi_note_cards', write: true }), /explicit --allow-mainnet/);
  assert.equal(f.state.sourceReads, 0); assert.equal(f.state.prompts, 0);
});

test('target card JSON validates exact clean-card identity, display name, image and artwork name', () => {
  const metadata = { id: 1, name: 'Card #1', image: 'https://cdn.lil.org/nft/mi_note_cards/clean/1.png', external_url: 'https://mons.shop',
    attributes: [{ trait_type: 'type', value: 'card' }, { trait_type: 'redeemed', value: false }, { trait_type: 'name', value: 'Artwork' }],
    properties: { files: [{ uri: 'https://cdn.lil.org/nft/mi_note_cards/clean/1.png', type: 'image/png' }] } };
  assert.match(validateMiNoteUpgradeTargetMetadata(JSON.stringify(metadata), 1, 'Artwork'), /^[a-f0-9]{64}$/);
  for (const changed of [{ id: 2 }, { name: 'Preorder #1' }, { image: 'wrong' }, { attributes: [] }, { properties: { files: [] } }]) {
    assert.throws(() => validateMiNoteUpgradeTargetMetadata(JSON.stringify({ ...metadata, ...changed }), 1, 'Artwork'));
  }
});

test('manifest source binds permanent claims, target hashes, roles and the immutable inventory without freezing live stock counts', async t => {
  const f = await fixture(t);
  f.sourceArgs.available -= 2; f.sourceArgs.assigned += 2;
  const changed = await validateMiNoteUpgradeSource(f.sourceArgs);
  assert.equal(validateMiNoteUpgradeManifest(f.manifest, changed, f.state.programs), f.manifest);
  for (const mutation of [
    () => { f.sourceArgs.snapshot.orders[0].status = 'submitted'; },
    () => { f.sourceArgs.snapshot.claims.pop(); },
  ]) {
    const original = structuredClone(f.sourceArgs.snapshot); mutation();
    await assert.rejects(validateMiNoteUpgradeSource(f.sourceArgs));
    f.sourceArgs.snapshot = original;
  }
  assert.throws(() => validateMiNoteUpgradeManifest({ ...f.manifest, assets: f.manifest.assets.slice(1) }, f.source, f.state.programs));
  assert.throws(() => validateMiNoteUpgradeManifest(f.manifest, { ...f.source, targetMetadataSha256: 'c'.repeat(64) }, f.state.programs));
});

test('prepare and preview are key-free, immutable, and simulate all22 as six batches of at most four', async t => {
  const f = await fixture(t);
  const preparePath = path.join(f.root, 'prepared.json');
  const prepared = await runMiNotePreorderUpgrade({ ...f.options, manifestPath: undefined, preparePath }, f.dependencies);
  assert.equal(prepared.mode, 'prepared');
  await assert.rejects(runMiNotePreorderUpgrade({ ...f.options, manifestPath: undefined, preparePath }, f.dependencies), /will not be overwritten/);
  const preview = await f.run();
  assert.equal(preview.mode, 'preview');
  assert.equal('simulations' in preview && preview.simulations.length, 6);
  assert.equal(f.state.simulations, 6); assert.equal(f.state.prompts, 0); assert.deepEqual(f.state.sends, []);
  assert.equal(existsSync(f.journalPath), false);
});

test('all22 metadata-only updates finish in six transactions and preserve current owners and permanent source', async t => {
  const f = await fixture(t);
  const sourceBefore = JSON.stringify(f.sourceArgs);
  const result = await f.run({ write: true, yes: true });
  assert.equal(result.mode, 'write'); assert.equal('complete' in result && result.complete, true);
  assert.equal(f.state.prompts, 1); assert.equal(f.state.sends.length, 6);
  assert.equal(JSON.stringify(f.sourceArgs), sourceBefore);
  const journal = readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal;
  assert.equal(journal.status, 'complete');
  assert.deepEqual(journal.attempts.map(attempt => attempt.cardIds.length), [4, 4, 4, 4, 4, 2]);
  assert.ok(journal.attempts.every(attempt => attempt.preservationVerifiedAtSlot !== undefined));
  assert.equal(readFileSync(f.journalPath, 'utf8').includes(bs58.encode(f.payer.secretKey)), false);
  for (const asset of f.source.assets) {
    const state = inspectMiNoteUpgradeAsset(f.accounts.get(asset.address)!, asset, f.source);
    assert.equal(state.state, 'target'); assert.equal(state.owner, f.holder.toBase58());
  }
  await f.run({ check: true });
  const first = f.source.assets[0];
  f.accounts.get(first.address)!.data = f.assetBytes(first.id, true, Keypair.generate().publicKey);
  await f.run({ check: true });
  await f.run({ write: true, yes: true });
  assert.equal(f.state.prompts, 1); assert.equal(f.state.sends.length, 6);
});

test('an uncertain unsent batch resumes exactly the saved bytes before preparing further signatures', async t => {
  const f = await fixture(t); f.state.failure = 'before';
  await assert.rejects(f.run({ write: true, yes: true }), /uncertain/);
  const first = readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal.attempts[0];
  assert.equal(first.status, 'signed');
  await f.run({ write: true, yes: true });
  assert.equal(f.state.sends[0], f.state.sends[1]);
  assert.equal(f.state.sends.length, 7);
  assert.equal(readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal.attempts.length, 6);
});

test('interruption after landing resolves against saved preservation evidence without a duplicate send', async t => {
  const f = await fixture(t); f.state.failure = 'interrupt';
  await assert.rejects(f.run({ write: true, yes: true }), /interrupted/);
  assert.equal(readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal.attempts[0].status, 'signed');
  await f.run({ write: true, yes: true });
  assert.equal(f.state.sends.length, 6);
});

test('finalized failure retains history and a reused signature cannot poison the journal', async t => {
  const f = await fixture(t); f.state.failure = 'failed';
  await assert.rejects(f.run({ write: true, yes: true }), /attempt failed/);
  const original = readFileSync(f.journalPath, 'utf8');
  const first = JSON.parse(original).attempts[0];
  f.state.repeatHash = { blockhash: first.blockhash, lastValidBlockHeight: first.lastValidBlockHeight };
  await assert.rejects(f.run({ write: true, yes: true }), /reused an earlier upgrade signature/);
  assert.equal(readFileSync(f.journalPath, 'utf8'), original); assert.equal(f.state.sends.length, 1);
  f.state.repeatHash = undefined;
  await f.run({ write: true, yes: true });
  const attempts = readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal.attempts;
  assert.equal(attempts.length, 7); assert.equal(attempts[0].status, 'failed');
});

test('definitive expiry permits a fresh signature only after preserving the expired attempt', async t => {
  const f = await fixture(t); f.state.failure = 'before';
  await assert.rejects(f.run({ write: true, yes: true }), /uncertain/);
  f.state.height += 1000;
  await f.run({ write: true, yes: true });
  const attempts = readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal.attempts;
  assert.equal(attempts[0].status, 'expired'); assert.notEqual(attempts[0].signature, attempts[1].signature);
});

test('unexpected or burned asset state and simulation ownership changes stop before signing', async t => {
  const f = await fixture(t); const asset = f.source.assets[0]; const original = f.accounts.get(asset.address)!;
  for (const bad of [account(Buffer.from([0])), account(Buffer.concat([original.data, Buffer.from([3])])), account(original.data, SystemProgram.programId.toBase58())]) {
    f.accounts.set(asset.address, bad);
    await assert.rejects(f.run({ write: true, yes: true }));
  }
  f.accounts.set(asset.address, original); f.state.corruptSimulation = true;
  await assert.rejects(f.run({ write: true, yes: true }), /protected fields/);
  assert.equal(f.state.prompts, 0); assert.deepEqual(f.state.sends, []);
});

test('manifest changes during key entry and saved preservation changes prevent new broadcasts', async t => {
  const f = await fixture(t);
  f.state.onPrompt = () => writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath, 'utf8')}\n`);
  await assert.rejects(f.run({ write: true, yes: true }), /manifest changed/);
  assert.deepEqual(f.state.sends, []);
  writeFileSync(f.manifestPath, `${JSON.stringify(f.manifest, null, 2)}\n`); f.state.onPrompt = undefined; f.state.failure = 'before';
  await assert.rejects(f.run({ write: true, yes: true }), /uncertain/);
  const first = f.source.assets[0]; f.accounts.get(first.address)!.data = f.assetBytes(first.id, false, Keypair.generate().publicKey);
  await assert.rejects(f.run({ write: true, yes: true }), /saved ownership/);
  assert.equal(f.state.sends.length, 1);
});

test('exact signed journal validation rejects NFT transfers, metadata tampering and foreign manifests', async t => {
  const f = await fixture(t); f.state.failure = 'before';
  await assert.rejects(f.run({ write: true, yes: true }), /uncertain/);
  const original = readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()).journal.attempts[0];
  const instruction = buildMiNotePreorderUpdateInstruction(f.manifest, f.source.assets[0]);
  assert.equal(instruction.data[0], 15); assert.equal(instruction.data.at(-1), 0);
  assert.equal(instruction.keys[1].isWritable, false);
  assert.equal(instruction.keys.some(key => key.pubkey.equals(f.holder)), false);
  const correct = buildMiNoteUpgradeTransaction(f.manifest, original.cardIds, original.blockhash);
  correct.sign([f.payer]); assert.equal(bs58.encode(correct.signatures[0]), original.signature);
  const malicious = new VersionedTransaction(new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: original.blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: f.holder, lamports: 1 })] }).compileToV0Message());
  malicious.sign([f.payer]);
  const attempt: MiNoteUpgradeAttempt = { ...original, signature: bs58.encode(malicious.signatures[0]), transactionBase64: Buffer.from(malicious.serialize()).toString('base64') };
  assert.throws(() => validateMiNoteUpgradeAttempt(attempt, f.manifest), /exact authority-signed metadata-only/);
  await assert.rejects(f.run({ check: true }), /pending/);
});

test('read-only checks validate pending preservation evidence and reject contradictory journal floors', async t => {
  const f = await fixture(t); f.state.failure = 'interrupt';
  await assert.rejects(f.run({ write: true, yes: true }), /interrupted/);
  const original = readFileSync(f.journalPath, 'utf8');
  await assert.rejects(f.run({ check: true }), /18 assets still have preorder metadata/);
  assert.equal(readFileSync(f.journalPath, 'utf8'), original);
  for (const mutate of [
    (journal: ReturnType<typeof readMiNoteUpgradeJournal>['journal']) => { journal.attempts[0].preservationVerifiedAtSlot = 1001; },
    (journal: ReturnType<typeof readMiNoteUpgradeJournal>['journal']) => {
      Object.assign(journal.attempts[0], { status: 'finalized', finalizedSlot: 1001, preservationVerifiedAtSlot: 1001 });
      journal.lastVerifiedSlot = 1000;
    },
  ]) {
    const journal = JSON.parse(original); mutate(journal); writeFileSync(f.journalPath, JSON.stringify(journal));
    assert.throws(() => readMiNoteUpgradeJournal(f.journalPath, f.manifest, new Date()));
  }
  writeFileSync(f.journalPath, original);
  const asset = f.source.assets[0]; f.accounts.get(asset.address)!.data = f.assetBytes(asset.id, true, Keypair.generate().publicKey);
  await assert.rejects(f.run({ check: true }), /saved ownership/);
  assert.equal(f.state.prompts, 1); assert.equal(f.state.sends.length, 1);
});

test('concurrent upgrade writers are rejected before any key prompt or send', async t => {
  const f = await fixture(t);
  const release = acquireDeploymentRegistryMutationLock({ root: f.root, operation: 'existing migration' });
  try { await assert.rejects(f.run({ write: true, yes: true }), /Another deployment-registry operation/); }
  finally { release(); }
  assert.equal(f.state.prompts, 0); assert.deepEqual(f.state.sends, []); assert.equal(existsSync(f.journalPath), false);
});
