import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount, AddressLookupTableInstruction, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo,
} from '@solana/web3.js';
import { DEPLOYMENT_DROPS } from '../shared/deploymentRegistry.ts';
import { getPreorderConfig, PREORDER_PAYMENT_RECIPIENTS } from '../shared/preorders.ts';
import { decodeBoxMinterConfigData } from '../shared/boxMinterConfigCodec.ts';
import { defineNewDropConfig } from '../scripts/shared/newDropConfig.ts';
import { preparePreorderCollectionConfig } from '../scripts/shared/preorderCollectionConfig.ts';
import { parseMiNoteDropManifest, MI_NOTE_CLUSTER_GENESIS } from '../scripts/shared/miNoteDropManifest.ts';
import { resolveMiNoteCollectionDelegates } from '../scripts/shared/miNoteMintResources.ts';
import { readDeploymentDropRegistry } from '../scripts/shared/deploymentRegistry.ts';
import { NEW_PREORDER_COLLECTION } from '../scripts/newPreorderCollections/mi_note_cards.ts';
import { bubblegumTreeConfigPda, decodeMplCoreCollectionUpdateDelegates } from '../scripts/deploy-all-onchain.ts';
import {
  buildTwoConfigDelegateUpdateInstruction, createTwoConfigDeploymentPlan, inspectTwoConfigJournalTransaction,
  parseTwoConfigDeploymentArgs, runTwoConfigDropDeployment, validateTwoConfigJournalTransaction,
  type TwoConfigDeploymentDependencies, type TwoConfigDeploymentPlan, type TwoConfigJournalTransaction,
} from '../scripts/deploy-two-config-drop.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, MPL_CORE_PROGRAM_ADDRESS,
} from '../shared/solanaProgramAddresses.ts';

const manifest = parseMiNoteDropManifest(JSON.parse(readFileSync(new URL('../releases/mi-note-cards-devnet/inventory.json', import.meta.url), 'utf8')));
const source = DEPLOYMENT_DROPS.clear_cards_devnet_v3;
const DISABLED_DISCOUNT_ROOT = createHash('sha256').update(SystemProgram.programId.toBuffer()).digest();

function recipe(mainnet = false) {
  const selectedManifest = mainnet ? parseMiNoteDropManifest(JSON.parse(readFileSync(
    new URL('../releases/mi-note-cards/inventory.json', import.meta.url), 'utf8',
  ))) : manifest;
  const selectedSource = mainnet ? DEPLOYMENT_DROPS.card_nft_2 : source;
  return defineNewDropConfig({
    shared: { isMainnet: mainnet, dropSymbol: 'minote', sellerFeeBasisPoints: 500 },
    deploy: { reuseProgramId: true, reuseProgramIdFromDropId: selectedSource.dropId, coreCollectionPubkey: selectedManifest.sourcePreorder.collection },
    onchain: {
      dropId: selectedManifest.sourcePreorder.preorderId, dropFamily: 'mi_note_cards', metadataBase: selectedManifest.metadataBase,
      collectionMetadata: { name: 'Mi Note Cards', description: 'mi note cards', externalUrl: 'https://mons.shop',
        image: NEW_PREORDER_COLLECTION.collectionMetadata.image, creators: NEW_PREORDER_COLLECTION.collectionMetadata.creators },
      discountWhitelistCsvRelativePath: 'scripts/discounts/disabled.csv', receiptsTree: { maxDepth: 14, maxBufferSize: 64, canopyDepth: 0 },
      paymentRouting: { mintProceeds: [
        { address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 }, { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 },
      ], deliveryPaymentReceiver: mainnet ? PREORDER_PAYMENT_RECIPIENTS[1] : getPreorderConfig(selectedManifest.sourcePreorder.preorderId)!.authority },
      priceSol: mainnet ? 0.5 : 0.25, discountPriceSol: mainnet ? 0.5 : 0.25, stripeCheckoutEnabled: false, discountMintsPerWallet: 1,
      maxSupply: selectedManifest.packCount, itemsPerBox: 2, maxPerTx: 15, namePrefix: 'pack', figureNamePrefix: 'card',
      operationsConfig: { configId: `${selectedManifest.sourcePreorder.preorderId}_operations`, maxSupply: 715 },
      inventoryManifest: { sha256: selectedManifest.sha256, cardIds: [...selectedManifest.eligibleCardIds] },
    },
  });
}

const int = (value: number | bigint, size: 2 | 4 | 8) => {
  const bytes = Buffer.alloc(size);
  if (size === 8) bytes.writeBigUInt64LE(BigInt(value));
  else if (size === 4) bytes.writeUInt32LE(Number(value));
  else bytes.writeUInt16LE(Number(value));
  return bytes;
};
const str = (value: string) => Buffer.concat([int(Buffer.byteLength(value), 4), Buffer.from(value)]);
const account = (data: Buffer, owner: string, lamports = 1_000_000): AccountInfo<Buffer> => ({
  data, owner: new PublicKey(owner), lamports, executable: false, rentEpoch: 0,
});

function collectionBytes(authority: PublicKey, delegates: PublicKey[]) {
  const metadata = NEW_PREORDER_COLLECTION.collectionMetadata;
  const base = Buffer.concat([Buffer.from([5]), authority.toBuffer(), str(metadata.name),
    str(NEW_PREORDER_COLLECTION.collectionMetadataUri), int(22, 4), int(22, 4)]);
  const plugins = [
    { type: 0, authority: Buffer.from([2]), data: Buffer.concat([Buffer.from([0]), int(500, 2), int(1, 4),
      new PublicKey(metadata.creators[0].address).toBuffer(), Buffer.from([100, 0])]) },
    { type: 4, authority: Buffer.from([2]), data: Buffer.concat([Buffer.from([4]), int(delegates.length, 4), ...delegates.map(key => key.toBuffer())]) },
    { type: 15, authority: Buffer.concat([Buffer.from([3]), new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS).toBuffer()]), data: Buffer.from([15]) },
  ];
  let offset = base.length + 9;
  const records = plugins.map(plugin => {
    const record = Buffer.concat([Buffer.from([plugin.type]), plugin.authority, int(offset, 8)]);
    offset += plugin.data.length;
    return record;
  });
  return Buffer.concat([base, Buffer.from([3]), int(offset, 8), ...plugins.map(plugin => plugin.data),
    Buffer.from([4]), int(3, 4), ...records, int(0, 4)]);
}

function roleAccount(plan: TwoConfigDeploymentPlan, kind: 'mint' | 'operations', config: ReturnType<typeof recipe>) {
  const role = kind === 'mint' ? plan.mintConfig : plan.operationsConfig;
  const drop = config.onchain;
  const authority = new PublicKey(plan.authority);
  const seed = createHash('sha256').update(role.configId).digest();
  const bump = PublicKey.findProgramAddressSync([Buffer.from('config'), seed], new PublicKey(plan.programId))[1];
  const base = Buffer.concat([
    Buffer.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]), authority.toBuffer(),
    new PublicKey(drop.paymentRouting!.deliveryPaymentReceiver).toBuffer(), new PublicKey(plan.collection).toBuffer(),
    int(Math.round(drop.priceSol * 1_000_000_000), 8), int(Math.round(drop.discountPriceSol * 1_000_000_000), 8), DISABLED_DISCOUNT_ROOT, int(role.maxSupply, 4),
    Buffer.from([15, role.itemsPerBox]), int(0, 4), str('pack'), str('minote'), str(drop.metadataBase),
    Buffer.from([0, bump, 1]), str('card'), Buffer.alloc(37), seed,
  ]);
  const extension = Buffer.alloc(112);
  Buffer.from('MONSPAY\0').copy(extension); extension[8] = 1; extension[9] = 2;
  PREORDER_PAYMENT_RECIPIENTS.forEach((address, index) => new PublicKey(address).toBuffer().copy(extension, 10 + index * 32));
  extension[106] = 50; extension[107] = 50;
  return account(Buffer.concat([base, Buffer.alloc(376 - base.length), extension]), plan.programId);
}

function treeAccounts(plan: TwoConfigDeploymentPlan) {
  const tree = Buffer.alloc(plan.receiptTree.space);
  tree[0] = 1; tree.writeUInt32LE(64, 2); tree.writeUInt32LE(14, 6);
  const configKey = bubblegumTreeConfigPda(new PublicKey(plan.receiptTree.address));
  configKey.toBuffer().copy(tree, 10);
  const config = Buffer.alloc(96);
  Buffer.from([122, 245, 175, 248, 171, 34, 0, 207]).copy(config);
  new PublicKey(plan.authority).toBuffer().copy(config, 8);
  new PublicKey(plan.authority).toBuffer().copy(config, 40);
  config.writeBigUInt64LE(16384n, 72); config[90] = 1;
  return [account(tree, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS), account(config, BUBBLEGUM_PROGRAM_ADDRESS)] as const;
}

function lookupAccount(authority: PublicKey, addresses: PublicKey[], slot: number) {
  const data = Buffer.alloc(56 + addresses.length * 32);
  data.writeUInt32LE(1); data.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4); data.writeBigUInt64LE(BigInt(slot), 12);
  data[21] = 1; authority.toBuffer().copy(data, 22);
  addresses.forEach((address, index) => address.toBuffer().copy(data, 56 + index * 32));
  return account(data, AddressLookupTableProgram.programId.toBase58());
}

async function fixture(t: TestContext, mainnet = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'two-config-drop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payer = Keypair.generate();
  const selectedManifest = mainnet ? parseMiNoteDropManifest(JSON.parse(readFileSync(
    new URL('../releases/mi-note-cards/inventory.json', import.meta.url), 'utf8',
  ))) : manifest;
  const selectedSource = mainnet ? DEPLOYMENT_DROPS.card_nft_2 : source;
  const preorder = getPreorderConfig(selectedManifest.sourcePreorder.preorderId)!;
  const originalAuthority = preorder.authority;
  Object.assign(preorder, { authority: payer.publicKey.toBase58() });
  t.after(() => Object.assign(preorder, { authority: originalAuthority }));
  const config = recipe(mainnet);
  const plan = await createTwoConfigDeploymentPlan({ config, manifest: selectedManifest, source: selectedSource });
  const registryPath = path.join(root, 'shared/deploymentRegistry.ts');
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `export const DEPLOYMENT_DROPS = ${JSON.stringify({ [selectedSource.dropId]: selectedSource })};\nexport const BOX_MINTER_CONFIG_TOMBSTONES = {};\n`);
  const manifestPath = path.join(root, 'inventory.json');
  writeFileSync(manifestPath, JSON.stringify(selectedManifest));
  const whitelistPath = path.join(root, config.onchain.discountWhitelistCsvRelativePath!);
  mkdirSync(path.dirname(whitelistPath), { recursive: true }); writeFileSync(whitelistPath, `${SystemProgram.programId.toBase58()}\n`);
  const saved = path.join(root, 'scripts/preorderCollectionDeployments', plan.cluster, `${plan.dropId}.json`);
  mkdirSync(path.dirname(saved), { recursive: true });
  writeFileSync(saved, JSON.stringify({ collectionMint: plan.collection, config: { authority: plan.authority } }));
  const journalPath = path.join(root, '.cache/two-config-deployments', plan.cluster, `${plan.dropId}.json`);
  const collectionConfig = preparePreorderCollectionConfig({
    ...NEW_PREORDER_COLLECTION, collectionId: plan.dropId, isMainnet: mainnet, authority: plan.authority,
  }, plan.dropId);
  const accounts = new Map<string, AccountInfo<Buffer>>([[plan.collection, account(collectionBytes(payer.publicKey, [payer.publicKey]), MPL_CORE_PROGRAM_ADDRESS)]]);
  const simulated = new Map<string, Map<string, AccountInfo<Buffer>>>();
  const signatures = new Map<string, number>();
  const state = { sends: [] as string[], prompts: 0, confirmations: 0, simulations: 0, gateChecks: 0, manifestChecks: 0,
    slot: selectedManifest.chain.slot + 1, height: 100, failSend: '' as '' | 'before' | 'after', approval: true,
    afterConfirmation: undefined as (() => void) | undefined };
  const connection = new Connection('https://fixture.example.com');
  t.mock.method(connection, 'getGenesisHash', async () => MI_NOTE_CLUSTER_GENESIS[plan.cluster]);
  t.mock.method(connection, 'getAccountInfo', async key => accounts.get(key.toBase58()) || null);
  t.mock.method(connection, 'getMultipleAccountsInfoAndContext', async keys => ({ context: { slot: state.slot }, value: keys.map(key => accounts.get(key.toBase58()) || null) }));
  t.mock.method(connection, 'getMinimumBalanceForRentExemption', async () => 1_000_000);
  t.mock.method(connection, 'getSlot', async () => state.slot);
  t.mock.method(connection, 'getBlockHeight', async () => state.height);
  t.mock.method(connection, 'getLatestBlockhash', async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: state.height + 100 }));
  t.mock.method(connection, 'getFeeForMessage', async () => ({ context: { slot: state.slot }, value: 5000 }));
  t.mock.method(connection, 'getSignatureStatuses', async values => ({ context: { slot: state.slot }, value: values.map(signature => signatures.has(signature)
    ? { slot: signatures.get(signature)!, confirmations: null, err: null, confirmationStatus: 'finalized' as const } : null) }));
  t.mock.method(connection, 'simulateTransaction', async (transaction: VersionedTransaction, options) => {
    state.simulations += 1;
    const effects = new Map<string, AccountInfo<Buffer>>();
    const instructions = TransactionMessage.decompile(transaction.message).instructions.filter(instruction => !instruction.programId.equals(ComputeBudgetProgram.programId));
    const instruction = instructions[0];
    if (instruction.programId.toBase58() === MPL_CORE_PROGRAM_ADDRESS) {
      const count = instruction.data.readUInt32LE(2);
      const delegates = Array.from({ length: count }, (_, index) => new PublicKey(instruction.data.subarray(6 + index * 32, 38 + index * 32)));
      effects.set(plan.collection, account(collectionBytes(payer.publicKey, delegates), MPL_CORE_PROGRAM_ADDRESS));
    } else if (instruction.programId.toBase58() === plan.programId) {
      const kind = instruction.keys[0].pubkey.toBase58() === plan.mintConfig.boxMinterConfigPda ? 'mint' : 'operations';
      effects.set(instruction.keys[0].pubkey.toBase58(), roleAccount(plan, kind, config));
    } else if (instruction.programId.equals(SystemProgram.programId)) {
      const [tree, treeConfig] = treeAccounts(plan);
      effects.set(plan.receiptTree.address, tree); effects.set(bubblegumTreeConfigPda(new PublicKey(plan.receiptTree.address)).toBase58(), treeConfig);
    } else {
      const create = AddressLookupTableInstruction.decodeCreateLookupTable(instruction);
      const extend = AddressLookupTableInstruction.decodeExtendLookupTable(instructions[1]);
      effects.set(instruction.keys[0].pubkey.toBase58(), lookupAccount(create.authority, extend.addresses, state.slot));
    }
    const identity = Buffer.from(transaction.message.serialize()).toString('base64'); simulated.set(identity, effects);
    return { context: { slot: state.slot }, value: { err: null, logs: [], unitsConsumed: 10_000,
      accounts: options?.accounts?.addresses.map(address => {
        const effect = effects.get(address)!;
        return { ...effect, owner: effect.owner.toBase58(), data: [effect.data.toString('base64'), 'base64'] };
      }) } };
  });
  t.mock.method(connection, 'sendRawTransaction', async raw => {
    const transaction = VersionedTransaction.deserialize(raw);
    const signature = bs58.encode(transaction.signatures[0]);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const entry = journal.transactions.find((entry: TwoConfigJournalTransaction) => entry.signature === signature);
    assert.equal(entry.status, 'signed');
    assert.equal(entry.transactionBase64, Buffer.from(raw).toString('base64'));
    state.sends.push(entry.transactionBase64);
    const failure = state.failSend; state.failSend = '';
    if (failure === 'before') throw new Error('transport lost before landing');
    const effects = simulated.get(Buffer.from(transaction.message.serialize()).toString('base64'))!;
    for (const [address, value] of effects) accounts.set(address, value);
    state.slot += 1; signatures.set(signature, state.slot);
    if (failure === 'after') throw new Error('transport lost after landing');
    return signature;
  });
  t.mock.method(connection, 'confirmTransaction', async () => ({ context: { slot: state.slot }, value: { err: null } }));
  const dependencies: Partial<TwoConfigDeploymentDependencies> = {
    createConnection: () => connection,
    loadConfig: async () => ({ config: structuredClone(config), configPath: 'fixture', knownDropIds: [plan.dropId] }),
    loadCollectionConfig: async () => ({ config: collectionConfig, configPath: 'fixture' }),
    verifyManifest: async value => { state.manifestChecks += 1; return value; },
    verifyGate: async () => {
      state.gateChecks += 1;
      return { gate: { schemaVersion: 1, status: 'passed', testTarget: 'two_config_existing_programs', completedAt: '2026-10-09T00:00:00Z',
        attestationSha256: 'a'.repeat(64), harnessSha256: 'b'.repeat(64), runnerSha256: 'c'.repeat(64), targets: [] },
      target: { cluster: plan.cluster, genesisHash: MI_NOTE_CLUSTER_GENESIS[plan.cluster], programs: [{ name: 'box_minter', programId: plan.programId,
        loader: 'fixture', programReadSlot: 1, bytes: 1, sha256: 'd'.repeat(64), file: 'fixture' }] } };
    },
    promptPrivateKey: async () => { state.prompts += 1; return bs58.encode(payer.secretKey); },
    confirm: async () => { state.confirmations += 1; state.afterConfirmation?.(); return state.approval; },
    log: () => {}, now: () => new Date('2026-10-09T00:00:00Z'),
  };
  const run = (write = true) => runTwoConfigDropDeployment({ root, dropId: plan.dropId, manifestPath, write, allowMainnet: mainnet && write }, dependencies);
  return { root, config, plan, accounts, payer, connection, state, dependencies, run, manifestPath, journalPath, registryPath, whitelistPath };
}

test('deployment CLI defaults to read-only and requires explicit manifest and mainnet write opt-in', () => {
  assert.deepEqual(parseTwoConfigDeploymentArgs(['mi_note_cards_devnet', '--manifest', 'inventory.json']), {
    dropId: 'mi_note_cards_devnet', manifestPath: 'inventory.json', write: false, allowMainnet: false, yes: false,
  });
  assert.equal(parseTwoConfigDeploymentArgs(['--help']), null);
  for (const args of [[], ['mi_note_cards_devnet'], ['mi_note_cards_devnet', '--manifest'],
    ['mi_note_cards_devnet', '--manifest', 'inventory.json', '--allow-mainnet'],
    ['mi_note_cards_devnet', '--manifest', 'inventory.json', '--yes'],
    ['mi_note_cards_devnet', '--manifest', 'inventory.json', '--write', '--write']]) {
    assert.throws(() => parseTwoConfigDeploymentArgs(args));
  }
});

test('explicit --write --yes retains simulation and masked signing without repeated confirmations', async t => {
  const f = await fixture(t);
  await runTwoConfigDropDeployment({ root: f.root, dropId: f.plan.dropId, manifestPath: f.manifestPath, write: true, allowMainnet: false, yes: true }, f.dependencies);
  assert.equal(f.state.confirmations, 0);
  assert.equal(f.state.prompts, 1);
  assert.equal(f.state.simulations, 5);
  assert.equal(f.state.sends.length, 5);
});

test('plan preserves logical inventory while deriving distinct reused-program roles and a reproducible tree', async () => {
  const config = recipe();
  const plan = await createTwoConfigDeploymentPlan({ config, manifest, source });
  assert.equal(plan.mintConfig.itemsPerBox, 0); assert.equal(plan.mintConfig.maxSupply, 704);
  assert.equal(plan.operationsConfig.itemsPerBox, 2); assert.equal(plan.operationsConfig.maxSupply, 715);
  assert.notEqual(plan.mintConfig.boxMinterConfigPda, plan.operationsConfig.boxMinterConfigPda);
  assert.deepEqual(await createTwoConfigDeploymentPlan({ config, manifest, source }), plan);
  for (const changed of [
    { ...config, deploy: { ...config.deploy, reuseProgramId: false } },
    { ...config, onchain: { ...config.onchain, maxSupply: 627 } },
    { ...config, onchain: { ...config.onchain, inventoryManifest: { ...config.onchain.inventoryManifest!, sha256: '0'.repeat(64) } } },
  ]) await assert.rejects(createTwoConfigDeploymentPlan({ config: changed, manifest, source }));
  await assert.rejects(createTwoConfigDeploymentPlan({ config, manifest, source: { ...source, solanaCluster: 'mainnet-beta' } }));
  const existing = [plan.authority, Keypair.generate().publicKey.toBase58(), plan.mintConfig.boxMinterConfigPda];
  const instruction = buildTwoConfigDelegateUpdateInstruction(plan, existing);
  assert.equal(instruction.data[0], 7); assert.equal(instruction.data[1], 4);
  const delegates = Array.from({ length: instruction.data.readUInt32LE(2) }, (_, index) =>
    new PublicKey(instruction.data.subarray(6 + index * 32, 38 + index * 32)).toBase58());
  assert.deepEqual(delegates, [...existing, plan.operationsConfig.boxMinterConfigPda]);
});

test('read-only deployment checks never prompt, simulate, write journals, or send transactions', async t => {
  const f = await fixture(t);
  const before = readFileSync(f.registryPath, 'utf8');
  const result = await f.run(false);
  assert.equal(result.ready, false); assert.equal(f.state.prompts, 0); assert.equal(f.state.confirmations, 0);
  assert.equal(f.state.simulations, 0); assert.deepEqual(f.state.sends, []);
  assert.equal(existsSync(f.journalPath), false); assert.equal(readFileSync(f.registryPath, 'utf8'), before);
});

test('omitted and empty no-discount CSVs pass read-only preflight without any delegate mutation', async t => {
  const f = await fixture(t);
  const registryBefore = readFileSync(f.registryPath, 'utf8');
  writeFileSync(f.whitelistPath, '');
  for (const omitted of [false, true]) {
    if (omitted) delete f.config.onchain.discountWhitelistCsvRelativePath;
    assert.equal((await f.run(false)).ready, false);
    assert.equal(f.state.prompts, 0); assert.equal(f.state.simulations, 0);
    assert.deepEqual(f.state.sends, []); assert.equal(existsSync(f.journalPath), false);
    assert.equal(readFileSync(f.registryPath, 'utf8'), registryBefore);
  }
});

test('a missing named CSV or discounted price without real wallets fails before any delegate mutation', async t => {
  const f = await fixture(t);
  rmSync(f.whitelistPath);
  await assert.rejects(f.run(false), /Missing discount whitelist CSV/);
  f.config.onchain.discountPriceSol = 0.2;
  for (const csv of ['', `${SystemProgram.programId.toBase58()}\n`]) {
    writeFileSync(f.whitelistPath, csv);
    await assert.rejects(f.run(false), /discounted price requires.*real wallets/);
  }
  assert.equal(f.state.gateChecks, 0); assert.equal(f.state.prompts, 0); assert.equal(f.state.simulations, 0);
  assert.deepEqual(f.state.sends, []); assert.equal(existsSync(f.journalPath), false);
});

test('a finalized-delegates-only journal safely resumes after correcting the external discount CSV', async t => {
  const f = await fixture(t);
  const simulate = f.connection.simulateTransaction.bind(f.connection);
  let failMint = true;
  t.mock.method(f.connection, 'simulateTransaction', async (transaction: VersionedTransaction, options) => {
    const instructions = TransactionMessage.decompile(transaction.message).instructions;
    if (failMint && instructions.some(instruction => instruction.programId.toBase58() === f.plan.programId)) {
      failMint = false;
      return { context: { slot: f.state.slot }, value: { err: { InstructionError: [1, { Custom: 6009 }] }, logs: ['DiscountNotConfigured'] } };
    }
    return simulate(transaction, options);
  });
  await assert.rejects(f.run(), /simulation failed/);
  const journalBefore = readFileSync(f.journalPath, 'utf8');
  const original = JSON.parse(journalBefore);
  assert.equal(original.transactions.length, 1); assert.equal(original.transactions[0].step, 'delegates');
  assert.equal(original.transactions[0].status, 'finalized');
  writeFileSync(f.whitelistPath, '');
  assert.equal((await f.run(false)).ready, false);
  assert.equal(readFileSync(f.journalPath, 'utf8'), journalBefore);
  writeFileSync(f.whitelistPath, `${SystemProgram.programId.toBase58()}\n`);
  await f.run();
  const resumed = JSON.parse(readFileSync(f.journalPath, 'utf8'));
  assert.equal(resumed.transactions[0].signature, original.transactions[0].signature);
  assert.equal(resumed.transactions.length, 5); assert.equal(f.state.sends.length, 5);
  assert.equal((await readDeploymentDropRegistry(f.registryPath)).drops[f.plan.dropId].discountMerkleRoot, DISABLED_DISCOUNT_ROOT.toString('hex'));
});

test('write workflow journals every signed transaction before broadcast and commits one finalized logical drop', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.ready, true); assert.equal(f.state.sends.length, 5); assert.equal(f.state.simulations, 5);
  assert.equal(f.state.prompts, 1); assert.equal(f.state.confirmations, 5);
  assert.ok(f.state.gateChecks >= 3); assert.ok(f.state.manifestChecks >= 4);
  const registry = await readDeploymentDropRegistry(f.registryPath);
  assert.equal(registry.drops[f.plan.dropId].maxSupply, 704); assert.equal(registry.drops[f.plan.dropId].itemsPerBox, 2);
  assert.equal(registry.drops[f.plan.dropId].operationsConfig?.maxSupply, 715);
  assert.deepEqual(Object.keys(registry.drops).sort(), [source.dropId, f.plan.dropId].sort());
  const journalSource = readFileSync(f.journalPath, 'utf8');
  const journal = JSON.parse(journalSource);
  assert.ok(journal.transactions.every((entry: TwoConfigJournalTransaction) => entry.status === 'finalized'));
  assert.equal(journalSource.includes(bs58.encode(f.payer.secretKey)), false);
  assert.equal(journalSource.includes(JSON.stringify([...f.payer.secretKey])), false);
  const record = JSON.parse(readFileSync(result.recordPath, 'utf8'));
  assert.equal(record.mintStarted, false);
  const delegates = decodeMplCoreCollectionUpdateDelegates(f.accounts.get(f.plan.collection)!.data)!;
  assert.deepEqual(delegates.delegates.map(key => key.toBase58()), [f.plan.authority, f.plan.mintConfig.boxMinterConfigPda, f.plan.operationsConfig.boxMinterConfigPda]);
  assert.deepEqual(record.collectionDelegates, delegates.delegates.map(key => key.toBase58()).sort());
  await f.run();
  assert.equal(f.state.sends.length, 5);
});

test('mainnet deploys the approved price and receivers into both stopped roles and one logical registry row', async t => {
  const f = await fixture(t, true);
  const result = await f.run();
  assert.equal(result.ready, true);
  assert.equal(f.state.sends.length, 5);
  assert.equal(f.state.simulations, 5);
  for (const role of [f.plan.mintConfig, f.plan.operationsConfig]) {
    const config = decodeBoxMinterConfigData(f.accounts.get(role.boxMinterConfigPda)!.data);
    assert.equal(config.started, false);
    assert.equal(config.minted, 0);
    assert.equal(config.maxSupply, role.maxSupply);
    assert.equal(config.itemsPerBox, role.itemsPerBox);
    assert.equal(config.priceLamports, 500_000_000n);
    assert.equal(config.discountPriceLamports, 500_000_000n);
    assert.equal(config.uriBase, 'https://cdn.lil.org/nft/mi_note_cards/json');
    assert.equal(new PublicKey(config.paymentRouting.deliveryPaymentReceiver).toBase58(), PREORDER_PAYMENT_RECIPIENTS[1]);
    assert.deepEqual(config.paymentRouting.mintProceeds.map(recipient => ({
      address: new PublicKey(recipient.address).toBase58(), percentage: recipient.percentage,
    })), PREORDER_PAYMENT_RECIPIENTS.map(address => ({ address, percentage: 50 })));
  }
  const registry = await readDeploymentDropRegistry(f.registryPath);
  assert.deepEqual(Object.keys(registry.drops).sort(), ['card_nft_2', 'mi_note_cards']);
  const drop = registry.drops.mi_note_cards;
  assert.equal(drop.maxSupply, 627);
  assert.equal(drop.itemsPerBox, 2);
  assert.equal(drop.operationsConfig?.maxSupply, 715);
  assert.equal(drop.inventoryManifest?.cardIds.length, 1254);
  const lookup = AddressLookupTableAccount.deserialize(f.accounts.get(drop.deliveryLookupTable!)!.data);
  for (const address of [f.plan.mintConfig.boxMinterConfigPda, f.plan.operationsConfig.boxMinterConfigPda, PREORDER_PAYMENT_RECIPIENTS[1]]) {
    assert.ok(lookup.addresses.some(key => key.toBase58() === address));
  }
  await f.run();
  assert.equal(f.state.sends.length, 5);
});

test('mainnet rejects the devnet price, wrong delivery receiver, wrong mint split and metadata before signing', async t => {
  const f = await fixture(t, true);
  const approved = structuredClone(f.config.onchain);
  const invalid = [
    { priceSol: 0.25 },
    { discountPriceSol: 0.25 },
    { paymentRouting: { ...approved.paymentRouting!, deliveryPaymentReceiver: f.plan.authority } },
    { paymentRouting: { ...approved.paymentRouting!, mintProceeds: PREORDER_PAYMENT_RECIPIENTS.map((address, index) => ({ address, percentage: index === 0 ? 100 : 0 })) } },
    { metadataBase: 'https://cdn.lil.org/nft/mi_note_cards/json/pre' },
  ];
  for (const change of invalid) {
    f.config.onchain = structuredClone(approved);
    Object.assign(f.config.onchain, change);
    await assert.rejects(f.run());
  }
  assert.equal(f.state.prompts, 0);
  assert.equal(f.state.simulations, 0);
  assert.deepEqual(f.state.sends, []);
  assert.equal(existsSync(f.journalPath), false);
});

for (const finalitySource of ['finalized', 'state-verified', 'journal'] as const) {
  test(`resume honors ${finalitySource} slots and reuses the finalized lookup table before registry publication`, async t => {
    const f = await fixture(t);
    let interruptPublication = true;
    f.dependencies.readRegistry = async filePath => {
      if (interruptPublication && f.state.sends.length === 5) throw new Error('interrupted before publication');
      return readDeploymentDropRegistry(filePath);
    };
    await assert.rejects(f.run(), /interrupted before publication/);
    assert.equal((await readDeploymentDropRegistry(f.registryPath)).drops[f.plan.dropId], undefined);
    const journal = JSON.parse(readFileSync(f.journalPath, 'utf8'));
    const lookupAddress = journal.lookupTable.address;
    assert.equal(journal.transactions.at(-1).step, 'lookup-table');
    assert.equal(journal.transactions.at(-1).finalizedSlot, f.state.slot);
    if (finalitySource === 'state-verified') journal.transactions.at(-1).status = 'state-verified';
    if (finalitySource === 'journal') journal.finalizedSlot = ++f.state.slot;
    writeFileSync(f.journalPath, JSON.stringify(journal));
    const journalBefore = readFileSync(f.journalPath, 'utf8');
    const knownFinalizedSlot = f.state.slot;
    interruptPublication = false;
    let stale = true;
    const requestedFloors: number[] = [];
    t.mock.method(f.connection, 'getMultipleAccountsInfoAndContext', async (keys, options) => {
      requestedFloors.push(typeof options === 'object' ? options.minContextSlot ?? 0 : 0);
      return { context: { slot: stale ? knownFinalizedSlot - 1 : f.state.slot },
        value: keys.map(key => stale && key.toBase58() === lookupAddress ? null : f.accounts.get(key.toBase58()) || null) };
    });
    await assert.rejects(f.run(), /stale finalized deployment state/);
    assert.equal(requestedFloors[0], knownFinalizedSlot);
    assert.equal(f.state.sends.length, 5);
    assert.equal(readFileSync(f.journalPath, 'utf8'), journalBefore);
    stale = false;
    assert.equal((await f.run()).ready, true);
    assert.equal(f.state.sends.length, 5);
    assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).lookupTable.address, lookupAddress);
    assert.ok(f.accounts.has(lookupAddress));
  });
}

for (const failure of ['before', 'after'] as const) test(`uncertain submission ${failure} landing recovers without creating duplicate resources`, async t => {
  const f = await fixture(t); f.state.failSend = failure;
  await assert.rejects(f.run(), /transport lost/);
  const first = JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions[0];
  assert.equal(first.status, 'signed');
  await f.run();
  assert.equal(f.state.sends.length, failure === 'before' ? 6 : 5);
  if (failure === 'before') assert.equal(f.state.sends[0], f.state.sends[1]);
  assert.ok(JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions.every((entry: TwoConfigJournalTransaction) => entry.status === 'finalized'));
});

test('delegates added during approval stop signing and are preserved by a fresh attempt', async t => {
  const f = await fixture(t);
  const added = Keypair.generate().publicKey;
  f.state.afterConfirmation = () => f.accounts.set(f.plan.collection,
    account(collectionBytes(f.payer.publicKey, [f.payer.publicKey, added]), MPL_CORE_PROGRAM_ADDRESS));
  await assert.rejects(f.run(), /Collection delegates changed after review/);
  assert.deepEqual(f.state.sends, []);
  assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions, []);
  f.state.afterConfirmation = undefined;
  const result = await f.run();
  assert.equal(result.ready, true);
  const expected = [f.plan.authority, added.toBase58(), f.plan.mintConfig.boxMinterConfigPda, f.plan.operationsConfig.boxMinterConfigPda];
  assert.deepEqual(decodeMplCoreCollectionUpdateDelegates(f.accounts.get(f.plan.collection)!.data)!.delegates.map(key => key.toBase58()),
    expected);
  const recordSource = readFileSync(result.recordPath, 'utf8');
  const record = JSON.parse(recordSource);
  const drop = (await readDeploymentDropRegistry(f.registryPath)).drops[f.plan.dropId];
  assert.deepEqual(record.collectionDelegates, expected.sort());
  assert.deepEqual(await resolveMiNoteCollectionDelegates(record, drop, f.plan.authority), expected);
  await assert.rejects(resolveMiNoteCollectionDelegates({ ...record, collectionDelegates: [...expected, expected[0]] }, drop, f.plan.authority));
  await assert.rejects(resolveMiNoteCollectionDelegates({ ...record, plan: { ...record.plan, manifestSha256: '0'.repeat(64) } }, drop, f.plan.authority));
  delete record.collectionDelegates;
  assert.deepEqual(await resolveMiNoteCollectionDelegates(record, drop, f.plan.authority), expected);
  const tampered = structuredClone(record);
  const delegateTransaction = tampered.transactions.find((entry: TwoConfigJournalTransaction) => entry.step === 'delegates');
  const bytes = Buffer.from(delegateTransaction.transactionBase64, 'base64');
  bytes[5] ^= 1;
  delegateTransaction.transactionBase64 = bytes.toString('base64');
  await assert.rejects(resolveMiNoteCollectionDelegates(tampered, drop, f.plan.authority));
  assert.deepEqual(await resolveMiNoteCollectionDelegates({ ...record, transactions: [] }, drop, f.plan.authority),
    [f.plan.authority, f.plan.mintConfig.boxMinterConfigPda, f.plan.operationsConfig.boxMinterConfigPda].sort());
  f.accounts.set(f.plan.collection, account(collectionBytes(f.payer.publicKey,
    [...expected.map(value => new PublicKey(value)), Keypair.generate().publicKey]), MPL_CORE_PROGRAM_ADDRESS));
  await assert.rejects(f.run(), /delegate/i);
  assert.equal(readFileSync(result.recordPath, 'utf8'), recordSource);
});

test('recovery cannot resend a signed update that removes a delegate added during approval', async t => {
  const f = await fixture(t);
  f.state.failSend = 'before';
  await assert.rejects(f.run(), /transport lost/);
  const added = Keypair.generate().publicKey;
  f.state.afterConfirmation = () => f.accounts.set(f.plan.collection,
    account(collectionBytes(f.payer.publicKey, [f.payer.publicKey, added]), MPL_CORE_PROGRAM_ADDRESS));
  await assert.rejects(f.run(), /Collection delegates changed after review/);
  assert.equal(f.state.sends.length, 1);
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions[0].status, 'signed');
  f.state.afterConfirmation = undefined;
  f.state.height += 200;
  assert.equal((await f.run()).ready, true);
  assert.ok(decodeMplCoreCollectionUpdateDelegates(f.accounts.get(f.plan.collection)!.data)!.delegates.some(key => key.equals(added)));
});

test('manifest changes during human confirmation block signing and the first broadcast', async t => {
  const f = await fixture(t);
  f.state.afterConfirmation = () => writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath, 'utf8')}\n`);
  await assert.rejects(f.run(), /manifest changed after review/);
  assert.deepEqual(f.state.sends, []);
  assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions, []);
});

test('a manifest change during a later confirmation stops the next transaction before signing', async t => {
  const f = await fixture(t);
  f.state.afterConfirmation = () => {
    if (f.state.confirmations === 2) writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath, 'utf8')}\n`);
  };
  await assert.rejects(f.run(), /manifest changed after review/);
  assert.equal(f.state.sends.length, 1);
  const journal = JSON.parse(readFileSync(f.journalPath, 'utf8'));
  assert.equal(journal.transactions.length, 1);
  assert.equal(journal.transactions[0].step, 'delegates');
  assert.equal(journal.transactions[0].status, 'finalized');
  assert.equal((await readDeploymentDropRegistry(f.registryPath)).drops[f.plan.dropId], undefined);
});

test('manifest changes during masked signer entry block automatic approval before broadcast', async t => {
  const f = await fixture(t);
  const original = f.dependencies.promptPrivateKey!;
  f.dependencies.promptPrivateKey = async () => {
    const secret = await original();
    writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath, 'utf8')}\n`);
    return secret;
  };
  await assert.rejects(runTwoConfigDropDeployment({ root: f.root, dropId: f.plan.dropId,
    manifestPath: f.manifestPath, write: true, allowMainnet: false, yes: true }, f.dependencies), /manifest changed after review/);
  assert.deepEqual(f.state.sends, []);
  assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions, []);
});

test('simulation failure or a changed binary gate cannot reach signing or broadcasting', async t => {
  const f = await fixture(t);
  t.mock.method(f.connection, 'simulateTransaction', async () => ({ context: { slot: f.state.slot }, value: { err: { Custom: 1 }, logs: [] } }));
  await assert.rejects(f.run(), /simulation failed/);
  assert.equal(f.state.prompts, 0); assert.deepEqual(f.state.sends, []);
  f.dependencies.verifyGate = async () => { throw new Error('binary gate changed'); };
  await assert.rejects(f.run(), /binary gate changed/);
  assert.equal(f.state.prompts, 0); assert.deepEqual(f.state.sends, []);
});

test('an expired absent attempt may be replaced only after finalized absence and keeps its public history', async t => {
  const f = await fixture(t); f.state.failSend = 'before';
  await assert.rejects(f.run(), /transport lost/);
  f.state.height += 200;
  await f.run();
  const entries = JSON.parse(readFileSync(f.journalPath, 'utf8')).transactions;
  assert.equal(entries[0].status, 'expired');
  assert.notEqual(entries[0].signature, entries[1].signature);
  assert.deepEqual(entries[0].resources, entries[1].resources);
  assert.equal(f.state.sends.length, 6);
});

test('a valid authority signature cannot turn a recovery journal into an unrelated transaction replay', async t => {
  const f = await fixture(t); f.state.failSend = 'before';
  await assert.rejects(f.run(), /transport lost/);
  const journal = JSON.parse(readFileSync(f.journalPath, 'utf8'));
  const entry = journal.transactions[0];
  const unrelated = new VersionedTransaction(new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: entry.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  unrelated.sign([f.payer]);
  entry.transactionBase64 = Buffer.from(unrelated.serialize()).toString('base64');
  entry.signature = bs58.encode(unrelated.signatures[0]);
  writeFileSync(f.journalPath, JSON.stringify(journal));
  await assert.rejects(f.run(), /recovered delegate|approved deployment/);
  assert.equal(f.state.sends.length, 1);
});

test('mainnet write attempts without the separate opt-in stop before gate or signer access', async t => {
  const f = await fixture(t);
  f.config.deploy.solanaCluster = 'mainnet-beta';
  await assert.rejects(f.run(), /both --write and --allow-mainnet/);
  assert.equal(f.state.gateChecks, 0); assert.equal(f.state.prompts, 0); assert.deepEqual(f.state.sends, []);
});

test('journal inspection distinguishes pending, failed, finalized, and definitively expired outcomes', async t => {
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })] }).compileToV0Message());
  transaction.sign([payer]);
  const entry: TwoConfigJournalTransaction = { step: 'mint-config', signature: bs58.encode(transaction.signatures[0]),
    transactionBase64: Buffer.from(transaction.serialize()).toString('base64'), blockhash, lastValidBlockHeight: 100,
    resources: [], signedAt: '2026-10-09T00:00:00Z', status: 'signed' };
  assert.ok(validateTwoConfigJournalTransaction(entry, payer.publicKey.toBase58()));
  assert.throws(() => validateTwoConfigJournalTransaction({ ...entry, signature: bs58.encode(new Uint8Array(64)) }, payer.publicKey.toBase58()));
  const connection = new Connection('https://fixture.example.com');
  t.mock.method(connection, 'getBlockHeight', async () => 101);
  t.mock.method(connection, 'getSignatureStatuses', async () => ({ context: { slot: 1 }, value: [null] }));
  assert.deepEqual(await inspectTwoConfigJournalTransaction(connection, entry), { status: 'expired' });
  for (const [confirmationStatus, err, expected] of [
    ['confirmed', null, 'pending'], ['finalized', null, 'finalized'], ['finalized', { InstructionError: [0, 'Custom'] }, 'failed'],
  ] as const) {
    t.mock.method(connection, 'getSignatureStatuses', async () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: null, confirmationStatus, err }] }));
    assert.equal((await inspectTwoConfigJournalTransaction(connection, entry)).status, expected);
  }
});
