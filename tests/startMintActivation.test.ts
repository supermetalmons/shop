import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import test, { type TestContext } from 'node:test';
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction, type AccountInfo,
} from '@solana/web3.js';
import { parseStartMintArgs, resolveDeploymentConfig, runStartMint, type StartMintDependencies } from '../scripts/startMint.ts';
import { getPreorderConfig, PREORDER_PAYMENT_RECIPIENTS } from '../shared/preorders.ts';
import type { DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import { resolveDropConfigRole } from '../shared/dropConfigRoles.ts';
import { parseMiNoteDropManifest, MI_NOTE_CLUSTER_GENESIS } from '../scripts/shared/miNoteDropManifest.ts';
import { validateNewMiNoteDropConfigs } from '../scripts/shared/miNoteInventoryPreflight.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';
import { verifyMiNoteMintResources } from '../scripts/shared/miNoteMintResources.ts';
import { preparePreorderCollectionConfig } from '../scripts/shared/preorderCollectionConfig.ts';
import { NEW_PREORDER_COLLECTION } from '../scripts/newPreorderCollections/mi_note_cards.ts';
import { bubblegumTreeConfigPda, getConcurrentMerkleTreeAccountSize } from '../scripts/deploy-all-onchain.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS,
} from '../shared/solanaProgramAddresses.ts';

const manifest = parseMiNoteDropManifest(JSON.parse(readFileSync(new URL('../releases/mi-note-cards-devnet/inventory.json', import.meta.url), 'utf8')));
const SMOKE_ID = '11111111-2222-4333-8444-555555555555';

function integer(value: number | bigint, bytes: 4 | 8) {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 4) buffer.writeUInt32LE(Number(value)); else buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}
function string(value: string) { const buffer = Buffer.from(value); return Buffer.concat([integer(buffer.length, 4), buffer]); }

function configuration(drop: DeploymentRegistryDrop, authority: PublicKey, role: 'mint' | 'operations', started: boolean, minted: number) {
  const expected = resolveDropConfigRole(drop, role);
  const base = Buffer.concat([
    Buffer.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]), authority.toBuffer(),
    new PublicKey(drop.paymentRouting?.deliveryPaymentReceiver || drop.treasury!).toBuffer(), new PublicKey(drop.collectionMint).toBuffer(),
    integer(Math.round(drop.priceSol * 1e9), 8), integer(Math.round(drop.discountPriceSol * 1e9), 8), Buffer.from(drop.discountMerkleRoot, 'hex'),
    integer(expected.maxSupply, 4), Buffer.from([drop.maxPerTx, expected.itemsPerBox]), integer(minted, 4),
    string(drop.namePrefix), string(drop.symbol), string(drop.metadataBase), Buffer.from([Number(started), 1, drop.discountMintsPerWallet]),
    string(drop.figureNamePrefix), Buffer.alloc(37), createHash('sha256').update(expected.configId).digest(),
  ]);
  const padded = Buffer.concat([base, Buffer.alloc(376 - base.length)]);
  if (!drop.paymentRouting) return padded;
  const extension = Buffer.alloc(112);
  Buffer.from('MONSPAY\0').copy(extension); extension[8] = 1; extension[9] = drop.paymentRouting.mintProceeds.length;
  drop.paymentRouting.mintProceeds.forEach((recipient, index) => {
    new PublicKey(recipient.address).toBuffer().copy(extension, 10 + index * 32); extension[106 + index] = recipient.percentage;
  });
  return Buffer.concat([padded, extension]);
}

async function fixture(t: TestContext, dual = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'start-mint-activation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payer = Keypair.generate();
  const preorder = getPreorderConfig('mi_note_cards_devnet')!;
  const originalAuthority = preorder.authority;
  Object.assign(preorder, { authority: payer.publicKey.toBase58() });
  t.after(() => Object.assign(preorder, { authority: originalAuthority }));
  const { treasury: _treasury, paymentRouting: _routing, ...base } = miNoteDropFixture();
  const drop: DeploymentRegistryDrop = dual ? { ...base,
    inventoryManifest: { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds },
    paymentRouting: { deliveryPaymentReceiver: payer.publicKey.toBase58(), mintProceeds: [
      { address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 }, { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 },
    ] },
  } : { ...base, dropId: 'legacy_cards', operationsConfig: undefined, inventoryManifest: undefined,
    maxSupply: 10, itemsPerBox: 1, treasury: payer.publicKey.toBase58() };
  if (dual) Object.assign(drop, { receiptsTreeMaxDepth: 14, receiptsTreeCanopyDepth: 0,
    deliveryLookupTable: new PublicKey(new Uint8Array(32).fill(92)).toBase58() });
  const registryPath = path.join(root, 'shared/deploymentRegistry.ts');
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `export const DEPLOYMENT_DROPS = ${JSON.stringify({ [drop.dropId]: drop })};\nexport const BOX_MINTER_CONFIG_TOMBSTONES = {};\n`);
  const manifestPath = path.join(root, 'inventory.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const activationPath = path.join(root, 'releases', drop.dropId.replaceAll('_', '-'), 'activation.json');
  const state = {
    started: false, minted: 0, operationsStarted: false, operationsMinted: 0, assigned: 0,
    slot: 100, height: 10, nextHash: 40, prompts: 0, confirmations: 0, simulations: 0, connectionCreates: 0, smokeCalls: 0,
    failure: '' as '' | 'before' | 'after' | 'failed', simulationFails: false, smokeFails: false,
    sends: [] as string[], logs: [] as string[], readiness: [] as boolean[], simulatedBlockhashes: [] as string[], lastSmokeSigner: undefined as Keypair | undefined,
    onPrompt: undefined as (() => void) | undefined, onConfirm: undefined as (() => void) | undefined,
  };
  const statuses = new Map<string, { slot: number; err: unknown; confirmationStatus: 'finalized' | 'confirmed' }>();
  const blockhashes = new Map<string, number>();
  const account = (data: Buffer): AccountInfo<Buffer> => ({ data, owner: new PublicKey(drop.boxMinterProgramId), executable: false, lamports: 1, rentEpoch: 0 });
  const mintAccount = (started = state.started) => account(configuration(drop, payer.publicKey, 'mint', started, state.minted));
  const operationsAccount = () => account(configuration(drop, payer.publicKey, 'operations', state.operationsStarted, state.operationsMinted));
  const connection = new Connection('https://fixture.example.com/?api-key=never-log-this-token');
  t.mock.method(connection, 'getGenesisHash', async () => MI_NOTE_CLUSTER_GENESIS.devnet);
  t.mock.method(connection, 'getMultipleAccountsInfoAndContext', async (keys: PublicKey[]) => ({ context: { slot: state.slot },
    value: keys.map((key) => key.toBase58() === drop.boxMinterConfigPda ? mintAccount() : operationsAccount()) }));
  t.mock.method(connection, 'getLatestBlockhash', async (options) => {
    assert.deepEqual(options, { commitment: 'finalized', minContextSlot: state.slot });
    const blockhash = new PublicKey(new Uint8Array(32).fill(state.nextHash++)).toBase58();
    const lastValidBlockHeight = state.height + 100; blockhashes.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight };
  });
  t.mock.method(connection, 'getLatestBlockhashAndContext', async options => ({
    context: { slot: state.slot }, value: await connection.getLatestBlockhash(options),
  }));
  t.mock.method(connection, 'getBlockHeight', async () => state.height);
  t.mock.method(connection, 'getEpochInfo', async () => ({ epoch: 1, slotIndex: 1, slotsInEpoch: 1000, absoluteSlot: state.slot, blockHeight: state.height }));
  t.mock.method(connection, 'isBlockhashValid', async (hash) => ({ context: { slot: state.slot }, value: state.height <= (blockhashes.get(hash) ?? 0) }));
  t.mock.method(connection, 'getSignatureStatuses', async (signatures) => ({ context: { slot: state.slot },
    value: signatures.map((signature) => statuses.has(signature) ? { ...statuses.get(signature)!, confirmations: null } : null) }));
  t.mock.method(connection, 'getFeeForMessage', async () => ({ context: { slot: state.slot }, value: 5000 }));
  t.mock.method(connection, 'simulateTransaction', async (transaction: VersionedTransaction, options) => {
    state.simulations += 1;
    state.simulatedBlockhashes.push(transaction.message.recentBlockhash);
    const instructions = TransactionMessage.decompile(transaction.message).instructions;
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].keys[0].pubkey.toBase58(), drop.boxMinterConfigPda);
    assert.deepEqual(instructions[0].data, createHash('sha256').update('global:start_mint').digest().subarray(0, 8));
    return { context: { slot: state.slot }, value: { err: state.simulationFails ? { Custom: 1 } : null,
      accounts: options?.accounts?.addresses.map((address) => {
        const value = address === drop.boxMinterConfigPda ? mintAccount(true) : operationsAccount();
        return { ...value, owner: value.owner.toBase58(), data: [value.data.toString('base64'), 'base64'] };
      }) } };
  });
  t.mock.method(connection, 'sendRawTransaction', async (bytes) => {
    const encoded = Buffer.from(bytes).toString('base64');
    const transaction = VersionedTransaction.deserialize(bytes);
    const signature = bs58.encode(transaction.signatures[0]);
    if (dual) {
      const journal = JSON.parse(readFileSync(activationPath, 'utf8'));
      assert.equal(journal.status, 'signed');
      assert.equal(journal.attempts.at(-1).status, 'signed');
      assert.equal(journal.attempts.at(-1).transactionBase64, encoded);
    } else assert.equal(existsSync(activationPath), false);
    state.sends.push(encoded);
    const failure = state.failure; state.failure = '';
    if (failure === 'before') throw new Error('lost before landing');
    state.slot += 1;
    if (failure !== 'failed') state.started = true;
    statuses.set(signature, { slot: state.slot, err: failure === 'failed' ? { InstructionError: [0, 'Custom'] } : null, confirmationStatus: 'finalized' });
    if (failure === 'after') throw new Error('lost after landing');
    return signature;
  });
  t.mock.method(connection, 'confirmTransaction', async (strategy) => {
    const status = statuses.get(typeof strategy === 'string' ? strategy : strategy.signature)!;
    return { context: { slot: status.slot }, value: { err: status.err } };
  });
  const dependencies: Partial<StartMintDependencies> = {
    createConnection: () => { state.connectionCreates += 1; return connection; },
    verifyReadiness: async (_drop, _path, options) => {
      state.readiness.push(Boolean(options?.allowActiveMint));
      validateNewMiNoteDropConfigs(drop, manifest, [mintAccount().data, operationsAccount().data], options);
      if (!state.started && state.assigned) throw new Error('Unused inventory required before first activation.');
    },
    promptPrivateKey: async () => { state.prompts += 1; state.onPrompt?.(); return bs58.encode(payer.secretKey); },
    confirm: async () => { state.confirmations += 1; state.onConfirm?.(); return true; },
    runSmoke: async (options) => {
      state.smokeCalls += 1; state.lastSmokeSigner = options.authority;
      await options.confirm?.(`DEVNET smoke\nRecovery ID: ${SMOKE_ID}`);
      if (state.smokeFails) throw new Error(`Smoke failed. Recover with --recover ${SMOKE_ID}.`);
      return { runId: SMOKE_ID, status: 'passed' };
    },
    now: () => new Date('2026-10-09T12:00:00.000Z'), log: (message) => state.logs.push(message),
  };
  const options = { root, dropId: drop.dropId, ...(dual ? { manifestPath } : {}), allowMainnet: false, yes: true, smoke: false };
  const run = (changes: Partial<typeof options> = {}) => runStartMint({ ...options, ...changes }, dependencies);
  return { root, drop, payer, connection, state, statuses, dependencies, options, run, manifestPath, activationPath, registryPath };
}

function resourceFixture(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, approvedCollectionDelegates?: readonly string[]) {
  const { drop, payer } = f;
  const config = preparePreorderCollectionConfig({ ...NEW_PREORDER_COLLECTION,
    collectionId: drop.dropId, isMainnet: false, authority: payer.publicKey.toBase58() }, drop.dropId);
  const account = (data: Buffer, owner: string): AccountInfo<Buffer> => ({
    data, owner: new PublicKey(owner), executable: false, lamports: 1, rentEpoch: 0,
  });
  const collection = (delegates = [config.authority, drop.boxMinterConfigPda!, drop.operationsConfig!.boxMinterConfigPda]) => {
    const metadata = config.collectionMetadata;
    const base = Buffer.concat([Buffer.from([5]), payer.publicKey.toBuffer(), string(metadata.name),
      string(config.collectionMetadataUri), integer(22, 4), integer(22, 4)]);
    const bps = Buffer.alloc(2); bps.writeUInt16LE(metadata.sellerFeeBasisPoints);
    const plugins = [
      { type: 0, authority: Buffer.from([2]), data: Buffer.concat([Buffer.from([0]), bps, integer(metadata.creators.length, 4),
        ...metadata.creators.map(creator => Buffer.concat([new PublicKey(creator.address).toBuffer(), Buffer.from([creator.share])])), Buffer.from([0])]) },
      { type: 4, authority: Buffer.from([2]), data: Buffer.concat([Buffer.from([4]), integer(delegates.length, 4), ...delegates.map(key => new PublicKey(key).toBuffer())]) },
      { type: 15, authority: Buffer.concat([Buffer.from([3]), new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS).toBuffer()]), data: Buffer.from([15]) },
    ];
    let offset = base.length + 9;
    const records = plugins.map(plugin => {
      const record = Buffer.concat([Buffer.from([plugin.type]), plugin.authority, integer(offset, 8)]);
      offset += plugin.data.length;
      return record;
    });
    return account(Buffer.concat([base, Buffer.from([3]), integer(offset, 8), ...plugins.map(plugin => plugin.data),
      Buffer.from([4]), integer(plugins.length, 4), ...records, integer(0, 4)]), MPL_CORE_PROGRAM_ADDRESS);
  };
  const treeConfigKey = bubblegumTreeConfigPda(new PublicKey(drop.receiptsMerkleTree)).toBase58();
  const tree = Buffer.alloc(getConcurrentMerkleTreeAccountSize(14, 64, 0));
  tree[0] = 1; tree.writeUInt32LE(64, 2); tree.writeUInt32LE(14, 6); new PublicKey(treeConfigKey).toBuffer().copy(tree, 10);
  const treeConfig = Buffer.alloc(96);
  Buffer.from([122, 245, 175, 248, 171, 34, 0, 207]).copy(treeConfig);
  payer.publicKey.toBuffer().copy(treeConfig, 8); payer.publicKey.toBuffer().copy(treeConfig, 40);
  treeConfig.writeBigUInt64LE(16384n, 72); treeConfig[90] = 1;
  const required = [...new Set([drop.boxMinterProgramId, drop.boxMinterConfigPda!, drop.operationsConfig!.boxMinterConfigPda,
    config.authority, drop.paymentRouting!.deliveryPaymentReceiver, drop.collectionMint,
    MPL_CORE_PROGRAM_ADDRESS, SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
    SPL_NOOP_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
    BUBBLEGUM_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS, drop.receiptsMerkleTree, treeConfigKey])];
  const lookup = Buffer.alloc(56 + required.length * 32);
  lookup.writeUInt32LE(1); lookup.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4); lookup.writeBigUInt64LE(90n, 12);
  lookup[21] = 1; payer.publicKey.toBuffer().copy(lookup, 22);
  required.forEach((address, index) => new PublicKey(address).toBuffer().copy(lookup, 56 + index * 32));
  const accounts = new Map([
    [drop.collectionMint, collection()], [drop.receiptsMerkleTree, account(tree, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS)],
    [treeConfigKey, account(treeConfig, BUBBLEGUM_PROGRAM_ADDRESS)],
    [drop.deliveryLookupTable!, account(lookup, AddressLookupTableProgram.programId.toBase58())],
  ]);
  const resources = { accounts, collection, tree, treeConfig, lookup, treeConfigKey, slot: undefined as number | undefined, reads: 0 };
  const read = f.connection.getMultipleAccountsInfoAndContext.bind(f.connection);
  t.mock.method(f.connection, 'getMultipleAccountsInfoAndContext', async (keys: PublicKey[], options) => {
    if (keys[0]?.toBase58() !== drop.collectionMint) return read(keys, options);
    assert.deepEqual(options, { commitment: 'finalized', minContextSlot: f.state.slot });
    resources.reads += 1;
    return { context: { slot: resources.slot ?? f.state.slot }, value: keys.map(key => accounts.get(key.toBase58()) ?? null) };
  });
  const verify = f.dependencies.verifyReadiness!;
  f.dependencies.verifyReadiness = async (...args) => {
    await verify(...args);
    await verifyMiNoteMintResources({ connection: f.connection, drop, collectionConfig: config,
      mintStarted: f.state.started, minimumSlot: f.state.slot, approvedCollectionDelegates });
  };
  return resources;
}

test('activation rejects malformed flags and operations IDs before contacting RPC or a signer', async (t) => {
  for (const args of [[], ['--yes'], ['mi_note_cards_devnet', '--manifest'], ['mi_note_cards_devnet', '--manifest', '--yes'],
    ['mi_note_cards_devnet', '--yes', '--yes'], ['mi_note_cards_devnet', '--write'], ['other', '--smoke']]) assert.throws(() => parseStartMintArgs(args));
  const f = await fixture(t);
  await assert.rejects(runStartMint({ ...f.options, dropId: f.drop.operationsConfig!.configId }, f.dependencies), /Operations configuration B/);
  assert.equal(f.state.connectionCreates, 0); assert.equal(f.state.prompts, 0);
  const mainnet = { ...f.drop, solanaCluster: 'mainnet-beta' as const };
  await assert.rejects(runStartMint(f.options, { ...f.dependencies,
    resolveDeployment: async () => ({ dropConfig: mainnet, knownDropIds: [mainnet.dropId], registryLabel: f.registryPath }),
  }), /explicit --allow-mainnet/);
  assert.equal(f.state.connectionCreates, 0);
});

test('--yes activation simulates, asks for one key, persists before sending and verifies B stays stopped', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.active, true); assert.equal(result.alreadyActive, false);
  assert.equal(f.state.prompts, 1); assert.equal(f.state.confirmations, 0); assert.equal(f.state.simulations, 2); assert.equal(f.state.sends.length, 1);
  const source = readFileSync(f.activationPath, 'utf8'); const journal = JSON.parse(source);
  assert.equal(journal.version, 2); assert.equal(journal.status, 'active'); assert.equal(journal.attempts[0].status, 'finalized');
  assert.equal(f.state.operationsStarted, false); assert.equal(f.state.operationsMinted, 0);
  assert.equal(source.includes(bs58.encode(f.payer.secretKey)), false);
  assert.equal(source.includes('never-log-this-token'), false); assert.equal(f.state.logs.join('\n').includes('never-log-this-token'), false);
});

test('activation verifies finalized collection, receipt and lookup resources again after key entry', async (t) => {
  const f = await fixture(t);
  const resources = resourceFixture(t, f);
  await f.run();
  assert.ok(resources.reads >= 2);
  assert.equal(f.state.sends.length, 1);
});

test('activation simulation waits for the blockhash context when it is newer than the account read', async t => {
  const f = await fixture(t);
  const latest = f.connection.getLatestBlockhashAndContext.bind(f.connection);
  const simulate = f.connection.simulateTransaction.bind(f.connection);
  t.mock.method(f.connection, 'getLatestBlockhashAndContext', async options => {
    const result = await latest(options);
    return { ...result, context: { slot: f.state.slot + 2 } };
  });
  t.mock.method(f.connection, 'simulateTransaction', async (transaction: VersionedTransaction, options) => {
    assert.equal(options?.minContextSlot, f.state.slot + 2);
    const result = await simulate(transaction, options);
    return { ...result, context: { slot: f.state.slot + 2 } };
  });
  assert.equal((await f.run()).active, true);
  assert.equal(f.state.sends.length, 1);
});

test('activation accepts an approved preserved delegate regardless of list order', async (t) => {
  const f = await fixture(t);
  const delegates = [f.payer.publicKey.toBase58(), Keypair.generate().publicKey.toBase58(),
    f.drop.boxMinterConfigPda!, f.drop.operationsConfig!.boxMinterConfigPda];
  const resources = resourceFixture(t, f, [...delegates].reverse());
  resources.accounts.set(f.drop.collectionMint, resources.collection(delegates));
  assert.equal((await f.run()).active, true);
  assert.equal(f.state.sends.length, 1);
  assert.ok(resources.reads >= 2);
});

for (const drift of ['unapproved extra', 'unexpected extra', 'missing preserved', 'missing B'] as const) {
  test(`activation rejects ${drift} delegation even with a preserved-delegate baseline`, async (t) => {
    const f = await fixture(t);
    const required = [f.payer.publicKey.toBase58(), f.drop.boxMinterConfigPda!, f.drop.operationsConfig!.boxMinterConfigPda];
    const preserved = Keypair.generate().publicKey.toBase58();
    const approved = drift === 'unapproved extra' ? undefined
      : drift === 'missing B' ? [...required.slice(0, 2), preserved] : [...required, preserved];
    const delegates = drift === 'unexpected extra' ? [...approved!, Keypair.generate().publicKey.toBase58()]
      : drift === 'missing preserved' ? required : approved ?? [...required, preserved];
    const resources = resourceFixture(t, f, approved);
    resources.accounts.set(f.drop.collectionMint, resources.collection(delegates));
    await assert.rejects(f.run());
    assert.equal(f.state.prompts, 0);
    assert.deepEqual(f.state.sends, []);
  });
}

for (const [name, mutate] of Object.entries({
  'missing A delegate': (r, f) => r.accounts.set(f.drop.collectionMint, r.collection([f.payer.publicKey.toBase58(), f.drop.operationsConfig!.boxMinterConfigPda])),
  'missing B delegate': (r, f) => r.accounts.set(f.drop.collectionMint, r.collection([f.payer.publicKey.toBase58(), f.drop.boxMinterConfigPda!])),
  'missing collection': (r, f) => r.accounts.delete(f.drop.collectionMint),
  'wrong collection authority': (r, f) => r.accounts.get(f.drop.collectionMint)!.data.fill(0, 1, 33),
  'missing Bubblegum plugin': (r, f) => {
    const account = r.accounts.get(f.drop.collectionMint)!;
    const base = 1 + 32 + 4 + Buffer.byteLength(NEW_PREORDER_COLLECTION.collectionMetadata.name) +
      4 + Buffer.byteLength(NEW_PREORDER_COLLECTION.collectionMetadataUri) + 8;
    account.data = account.data.subarray(0, base);
  },
  'missing receipt tree': (r, f) => r.accounts.delete(f.drop.receiptsMerkleTree),
  'missing receipt TreeConfig': r => r.accounts.delete(r.treeConfigKey),
  'wrong receipt tree owner': (r, f) => { r.accounts.get(f.drop.receiptsMerkleTree)!.owner = SystemProgram.programId; },
  'wrong receipt TreeConfig owner': r => { r.accounts.get(r.treeConfigKey)!.owner = SystemProgram.programId; },
  'wrong receipt tree authority': r => r.tree.fill(0, 10, 42),
  'wrong receipt tree depth': r => r.tree.writeUInt32LE(15, 6),
  'wrong receipt creator': r => r.treeConfig.fill(0, 8, 40),
  'wrong receipt delegate': r => r.treeConfig.fill(0, 40, 72),
  'public receipt tree': r => { r.treeConfig[88] = 1; },
  'receipt tree without room for remaining receipts': r => r.treeConfig.writeBigUInt64LE(16383n, 80),
  'missing lookup table': (r, f) => r.accounts.delete(f.drop.deliveryLookupTable!),
  'wrong lookup table owner': (r, f) => { r.accounts.get(f.drop.deliveryLookupTable!)!.owner = SystemProgram.programId; },
  'wrong lookup table authority': r => r.lookup.fill(0, 22, 54),
  'deactivated lookup table': r => r.lookup.writeBigUInt64LE(99n, 4),
  'lookup table missing B': r => r.lookup.fill(0, 56 + 64, 56 + 96),
  'unwarmed lookup table': r => r.lookup.writeBigUInt64LE(100n, 12),
  'stale resource snapshot': r => { r.slot = 99; },
} satisfies Record<string, (resources: ReturnType<typeof resourceFixture>, activation: Awaited<ReturnType<typeof fixture>>) => unknown>)) {
  test(`activation rejects ${name} before requesting a key or sending`, async (t) => {
    const f = await fixture(t);
    mutate(resourceFixture(t, f), f);
    await assert.rejects(f.run());
    assert.equal(f.state.prompts, 0);
    assert.deepEqual(f.state.sends, []);
  });
}

test('activation permits preorder receipts when capacity remains for every pack and card', async t => {
  const f = await fixture(t);
  const resources = resourceFixture(t, f);
  resources.treeConfig.writeBigUInt64LE(3n, 80);
  assert.equal((await f.run()).active, true);
  assert.equal(f.state.sends.length, 1);
});

test('losing B delegation during key entry prevents activation submission', async (t) => {
  const f = await fixture(t);
  const resources = resourceFixture(t, f);
  f.state.onPrompt = () => resources.accounts.set(f.drop.collectionMint,
    resources.collection([f.payer.publicKey.toBase58(), f.drop.boxMinterConfigPda!]));
  await assert.rejects(f.run(), /UpdateDelegate/);
  assert.equal(f.state.prompts, 1);
  assert.deepEqual(f.state.sends, []);
});

test('active mint verification permits its used receipt tree without another signature', async (t) => {
  const f = await fixture(t);
  f.state.started = true; f.state.minted = 1; f.state.assigned = 2;
  const resources = resourceFixture(t, f);
  resources.treeConfig.writeBigUInt64LE(3n, 80);
  assert.equal((await f.run()).alreadyActive, true);
  assert.equal(f.state.prompts, 0);
  assert.deepEqual(f.state.sends, []);
});

test('delayed key entry cannot consume the signed activation blockhash lifetime', async (t) => {
  const f = await fixture(t);
  f.state.onPrompt = () => { f.state.height += 1000; };
  await f.run();
  assert.equal(f.state.prompts, 1); assert.equal(f.state.simulatedBlockhashes.length, 2);
  assert.notEqual(f.state.simulatedBlockhashes[0], f.state.simulatedBlockhashes[1]);
  const attempt = JSON.parse(readFileSync(f.activationPath, 'utf8')).attempts[0];
  assert.equal(attempt.blockhash, f.state.simulatedBlockhashes[1]);
  assert.equal(VersionedTransaction.deserialize(Buffer.from(f.state.sends[0], 'base64')).message.recentBlockhash, attempt.blockhash);
  assert.ok(attempt.lastValidBlockHeight > f.state.height);
});

test('an already active mint is a verified no-op even after public inventory allocations', async (t) => {
  const f = await fixture(t); f.state.started = true; f.state.minted = 3; f.state.assigned = 6;
  const result = await f.run();
  assert.equal(result.alreadyActive, true); assert.equal(result.active, true);
  assert.equal(f.state.prompts, 0); assert.equal(f.state.simulations, 0); assert.deepEqual(f.state.sends, []);
  assert.ok(f.state.readiness.every(Boolean));
  f.state.operationsStarted = true;
  await assert.rejects(f.run(), /operations configuration B/);
  assert.deepEqual(f.state.sends, []);
});

for (const failure of ['before', 'after'] as const) test(`saved activation recovers loss ${failure} landing without a new signature or private key`, async (t) => {
  const f = await fixture(t); f.state.failure = failure;
  await assert.rejects(f.run(), /lost/);
  const before = JSON.parse(readFileSync(f.activationPath, 'utf8')).attempts[0];
  assert.equal(before.status, 'signed');
  const result = await f.run();
  assert.equal(result.active, true); assert.equal(f.state.prompts, 1);
  assert.equal(f.state.sends.length, failure === 'before' ? 2 : 1);
  if (failure === 'before') assert.equal(f.state.sends[0], f.state.sends[1]);
  const after = JSON.parse(readFileSync(f.activationPath, 'utf8'));
  assert.equal(after.attempts.length, 1); assert.equal(after.attempts[0].signature, before.signature); assert.equal(after.attempts[0].status, 'finalized');
});

test('a reused blockhash cannot duplicate activation history and a fresh retry still succeeds', async (t) => {
  const f = await fixture(t);
  f.state.failure = 'failed';
  await assert.rejects(f.run(), /failed at finality/);
  const original = readFileSync(f.activationPath, 'utf8');
  const first = JSON.parse(original).attempts[0];
  const freshBlockhash = f.connection.getLatestBlockhash.bind(f.connection);
  t.mock.method(f.connection, 'getLatestBlockhash', async (options) => {
    assert.deepEqual(options, { commitment: 'finalized', minContextSlot: f.state.slot });
    return { blockhash: first.blockhash, lastValidBlockHeight: first.lastValidBlockHeight };
  });
  await assert.rejects(f.run(), /reused a previous activation blockhash/);
  assert.equal(readFileSync(f.activationPath, 'utf8'), original);
  assert.equal(f.state.sends.length, 1);
  t.mock.method(f.connection, 'getLatestBlockhash', freshBlockhash);
  assert.equal((await f.run()).active, true);
  const attempts = JSON.parse(readFileSync(f.activationPath, 'utf8')).attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, 'failed');
  assert.equal(attempts[1].status, 'finalized');
  assert.notEqual(attempts[0].signature, attempts[1].signature);
  assert.equal(f.state.sends.length, 2);
});

for (const prior of ['expired', 'failed'] as const) test(`a definitively ${prior} attempt is durably archived before fresh signing`, async (t) => {
  const f = await fixture(t); f.state.failure = prior === 'expired' ? 'before' : 'failed';
  await assert.rejects(f.run(), prior === 'expired' ? /lost/ : /failed at finality/);
  const first = JSON.parse(readFileSync(f.activationPath, 'utf8')).attempts[0];
  if (prior === 'expired') f.state.height += 1000;
  f.state.onPrompt = () => assert.equal(JSON.parse(readFileSync(f.activationPath, 'utf8')).attempts[0].status, prior);
  await f.run();
  const attempts = JSON.parse(readFileSync(f.activationPath, 'utf8')).attempts;
  assert.equal(attempts.length, 2); assert.equal(attempts[0].signature, first.signature); assert.equal(attempts[0].status, prior);
  assert.equal(attempts[1].status, 'finalized'); assert.notEqual(attempts[1].signature, first.signature);
});

test('legacy signed activation is reconciled before the unstarted gate and keeps its original bytes', async (t) => {
  const f = await fixture(t); f.state.failure = 'before';
  await assert.rejects(f.run(), /lost/);
  const journal = JSON.parse(readFileSync(f.activationPath, 'utf8')); const attempt = journal.attempts[0];
  writeFileSync(f.activationPath, JSON.stringify({ version: 1, dropId: journal.dropId, cluster: journal.cluster, programId: journal.programId,
    mintConfig: journal.mintConfig, operationsConfig: journal.operationsConfig, manifestSha256: journal.manifestSha256,
    signature: attempt.signature, blockhash: attempt.blockhash, lastValidBlockHeight: attempt.lastValidBlockHeight,
    transactionBase64: attempt.transactionBase64, status: 'signed' }));
  f.state.started = true; f.state.minted = 1; f.state.assigned = 2;
  assert.equal((await f.run()).alreadyActive, true);
  const migrated = JSON.parse(readFileSync(f.activationPath, 'utf8'));
  assert.equal(migrated.version, 2); assert.equal(migrated.attempts[0].transactionBase64, attempt.transactionBase64);
  assert.equal(migrated.attempts[0].status, 'state-verified'); assert.equal(f.state.sends.length, 1); assert.equal(f.state.prompts, 1);
});

test('valid authority signatures cannot authorize a different recovery instruction or the operations config', async (t) => {
  const f = await fixture(t); f.state.failure = 'before';
  await assert.rejects(f.run(), /lost/);
  const original = readFileSync(f.activationPath, 'utf8');
  for (const operations of [false, true]) {
    const journal = JSON.parse(original); const attempt = journal.attempts[0];
    const prior = VersionedTransaction.deserialize(Buffer.from(attempt.transactionBase64, 'base64'));
    const instruction = TransactionMessage.decompile(prior.message).instructions[0];
    if (operations) instruction.keys[0].pubkey = new PublicKey(f.drop.operationsConfig!.boxMinterConfigPda);
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: attempt.blockhash,
      instructions: operations ? [instruction] : [SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message());
    transaction.sign([f.payer]); attempt.transactionBase64 = Buffer.from(transaction.serialize()).toString('base64'); attempt.signature = bs58.encode(transaction.signatures[0]);
    writeFileSync(f.activationPath, JSON.stringify(journal));
    await assert.rejects(f.run(), /exact authority-signed start_mint/);
  }
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.prompts, 1);
});

test('review-time manifest changes, journal edits and simulation failures cannot reach a new broadcast', async (t) => {
  const f = await fixture(t); f.state.simulationFails = true;
  await assert.rejects(f.run(), /simulation failed/); assert.equal(f.state.prompts, 0);
  f.state.simulationFails = false; f.state.onPrompt = () => writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath, 'utf8')}\n`);
  await assert.rejects(f.run(), /manifest changed/); assert.equal(f.state.sends.length, 0); assert.equal(existsSync(f.activationPath), false);
  writeFileSync(f.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); f.state.onPrompt = undefined; f.state.failure = 'before';
  await assert.rejects(f.run(), /lost/);
  f.state.onConfirm = () => writeFileSync(f.activationPath, `${readFileSync(f.activationPath, 'utf8')}\n`);
  await assert.rejects(f.run({ yes: false }), /journal changed after review/);
  assert.equal(f.state.sends.length, 1);
});

test('smoke reuses the activation signer, clears its retained bytes and does not repeat a successful smoke', async (t) => {
  const f = await fixture(t);
  await f.run({ smoke: true });
  assert.equal(f.state.prompts, 1); assert.equal(f.state.smokeCalls, 1);
  assert.ok(f.state.lastSmokeSigner!.secretKey.every((byte) => byte === 0));
  await f.run({ smoke: true });
  assert.equal(f.state.prompts, 1); assert.equal(f.state.smokeCalls, 1); assert.equal(f.state.sends.length, 1);
});

test('failed smoke preserves verified activation and requires standalone recovery of the same run', async (t) => {
  const f = await fixture(t); f.state.smokeFails = true;
  await assert.rejects(f.run({ smoke: true }), /--recover/);
  const journal = JSON.parse(readFileSync(f.activationPath, 'utf8'));
  assert.equal(journal.status, 'active'); assert.equal(journal.attempts[0].status, 'finalized');
  assert.deepEqual(journal.smoke, { runId: SMOKE_ID, status: 'recovery-required' });
  await assert.rejects(f.run({ smoke: true }), new RegExp(`standalone recovery.*${SMOKE_ID}`));
  assert.equal(f.state.smokeCalls, 1); assert.equal(f.state.prompts, 1); assert.equal(f.state.sends.length, 1);
});

test('single-config activation retains its direct command behavior without requiring a manifest or dual journal', async (t) => {
  const f = await fixture(t, false);
  const result = await f.run();
  assert.equal(result.active, true); assert.equal(result.activationPath, undefined); assert.equal(f.state.prompts, 1);
  assert.equal(f.state.simulations, 2); assert.equal(f.state.sends.length, 1); assert.equal(existsSync(f.activationPath), false);
  assert.equal((await f.run()).alreadyActive, true); assert.equal(f.state.sends.length, 1);
});

test('operations role cannot be resolved as a standalone activation target', async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolveDeploymentConfig({ root: f.root, requestedDropId: f.drop.operationsConfig!.configId }), /must remain unstarted/);
});
