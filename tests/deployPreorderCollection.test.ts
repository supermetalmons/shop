import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, VersionedTransaction, type AccountInfo, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  assertPreorderCollectionMetadata,
  parsePreorderCollectionArgs,
  runPreorderCollectionDeployment,
  validatePreorderCollectionAccount,
  type PreorderCollectionDeployDependencies,
} from '../scripts/deploy-preorder-collection.ts';
import {
  preparePreorderCollectionConfig,
  type PreparedPreorderCollectionConfig,
  type PreorderCollectionConfig,
} from '../scripts/shared/preorderCollectionConfig.ts';
import { buildCreateMplCoreCollectionV2Ix } from '../scripts/deploy-all-onchain.ts';
import { BUBBLEGUM_PROGRAM_ADDRESS, MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';

const CORE_PROGRAM = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const FIXED_DATE = new Date('2026-09-25T10:00:00.000Z');

function integer(value: number, size: 2 | 4 | 8): Buffer {
  const buffer = Buffer.alloc(size);
  if (size === 8) buffer.writeBigUInt64LE(BigInt(value));
  else if (size === 4) buffer.writeUInt32LE(value);
  else buffer.writeUInt16LE(value);
  return buffer;
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([integer(bytes.length, 4), bytes]);
}

function collectionAccount(
  config: PreparedPreorderCollectionConfig,
  overrides: {
    authority?: PublicKey;
    name?: string;
    uri?: string;
    delegates?: PublicKey[];
    royaltiesAuthority?: number;
    delegateAuthority?: number;
    basisPoints?: number;
    share?: number;
    ruleSet?: number;
    extraPlugin?: number;
    omitBubblegum?: boolean;
  } = {},
): AccountInfo<Buffer> {
  const authority = new PublicKey(config.authority);
  const base = Buffer.concat([
    Buffer.from([5]),
    (overrides.authority ?? authority).toBuffer(),
    string(overrides.name ?? config.collectionMetadata.name),
    string(overrides.uri ?? config.collectionMetadataUri),
    integer(0, 4), integer(0, 4),
  ]);
  const delegates = overrides.delegates ?? [authority];
  const royalties = Buffer.concat([
    Buffer.from([0]),
    integer(overrides.basisPoints ?? config.collectionMetadata.sellerFeeBasisPoints, 2),
    integer(config.collectionMetadata.creators.length, 4),
    ...config.collectionMetadata.creators.map((creator) => Buffer.concat([
      new PublicKey(creator.address).toBuffer(),
      Buffer.from([overrides.share ?? creator.share]),
    ])),
    Buffer.from([overrides.ruleSet ?? 0]),
  ]);
  const plugins = [
    { type: 0, authority: Buffer.from([overrides.royaltiesAuthority ?? 2]), data: royalties },
    { type: 4, authority: Buffer.from([overrides.delegateAuthority ?? 2]), data: Buffer.concat([
      Buffer.from([4]), integer(delegates.length, 4), ...delegates.map((key) => key.toBuffer()),
    ]) },
    ...(overrides.omitBubblegum ? [] : [{
      type: 15,
      authority: Buffer.concat([Buffer.from([3]), new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS).toBuffer()]),
      data: Buffer.from([15]),
    }]),
    ...(overrides.extraPlugin === undefined ? [] : [{
      type: overrides.extraPlugin, authority: Buffer.from([2]), data: Buffer.from([overrides.extraPlugin]),
    }]),
  ];
  let offset = base.length + 9;
  const records = plugins.map((plugin) => {
    const record = Buffer.concat([Buffer.from([plugin.type]), plugin.authority, integer(offset, 8)]);
    offset += plugin.data.length;
    return record;
  });
  return {
    executable: false,
    owner: CORE_PROGRAM,
    lamports: 3_000_000,
    rentEpoch: 0,
    data: Buffer.concat([
      base,
      Buffer.from([3]), integer(offset, 8),
      ...plugins.map((plugin) => plugin.data),
      Buffer.from([4]), integer(plugins.length, 4), ...records,
      integer(0, 4),
    ]),
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'preorder-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payer = Keypair.generate();
  const collection = Keypair.generate();
  const raw: PreorderCollectionConfig = {
    collectionId: 'mi_note_cards',
    isMainnet: true,
    solanaRpcUrl: 'https://rpc.example.com/private-api-key',
    authority: payer.publicKey.toBase58(),
    collectionMetadataUri: 'https://assets.example.com/mi_note_cards/collection.json',
    collectionMetadata: {
      name: 'Mi Note Cards',
      symbol: 'MINOTE',
      description: 'Mi Note Cards preorder collection',
      image: 'https://assets.example.com/mi_note_cards/cover.png',
      externalUrl: 'https://mons.shop',
      sellerFeeBasisPoints: 500,
      creators: [{ address: payer.publicKey.toBase58(), share: 100 }],
    },
  };
  const config = preparePreorderCollectionConfig(raw, raw.collectionId);
  const configPath = path.join(root, 'scripts/newPreorderCollections/mi_note_cards.ts');
  const writeConfig = (value: unknown = raw) => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `export const NEW_PREORDER_COLLECTION = ${JSON.stringify(value)};\n`);
  };
  writeConfig();
  const recordPath = path.join(root, 'scripts/preorderCollectionDeployments/mainnet-beta/mi_note_cards.json');
  const journalPath = path.join(root, '.cache/preorder-collection-deployments/mainnet-beta/mi_note_cards.json');
  const lockPath = journalPath.replace(/\.json$/, '.lock');
  const account = collectionAccount(config);
  const state = {
    account,
    collectionVisible: false,
    genesis: MAINNET_GENESIS,
    executable: true,
    simulationError: null as unknown,
    confirmationError: null as Error | null,
    confirmationValueError: null as unknown,
    finalizedSlot: 500,
    height: 100,
    signatureStatus: 'finalized' as 'finalized' | 'confirmed' | null,
    signature: '',
    sends: 0,
    prompts: 0,
    generated: 0,
    confirmations: 0,
    accountReads: [] as { commitment?: string; minContextSlot?: number }[],
    simulationTransaction: null as VersionedTransaction | null,
    approval: true,
  };
  const metadata = {
    name: raw.collectionMetadata.name,
    symbol: raw.collectionMetadata.symbol,
    description: raw.collectionMetadata.description,
    image: raw.collectionMetadata.image,
    external_url: raw.collectionMetadata.externalUrl,
    seller_fee_basis_points: raw.collectionMetadata.sellerFeeBasisPoints,
    properties: { creators: raw.collectionMetadata.creators },
  };
  const rpc = {
    getGenesisHash: async () => state.genesis,
    getAccountInfo: async (address: PublicKey) => {
      assert.ok(address.equals(CORE_PROGRAM));
      return { ...account, owner: SystemProgram.programId, executable: state.executable };
    },
    getAccountInfoAndContext: async (_address: PublicKey, options: { commitment?: string; minContextSlot?: number }) => {
      assert.equal(options.commitment, 'finalized');
      state.accountReads.push(options);
      return { context: { slot: state.finalizedSlot }, value: state.collectionVisible ? state.account : null };
    },
    getEpochInfo: async (commitment: string) => {
      assert.equal(commitment, 'finalized');
      return { blockHeight: state.height, absoluteSlot: state.finalizedSlot };
    },
    getSignatureStatuses: async () => ({
      context: { slot: state.finalizedSlot },
      value: [state.signatureStatus === null ? null : {
        slot: state.finalizedSlot, confirmations: null, err: null, confirmationStatus: state.signatureStatus,
      }],
    }),
    getLatestBlockhash: async () => ({ blockhash: collection.publicKey.toBase58(), lastValidBlockHeight: 200 }),
    simulateTransaction: async (transaction: VersionedTransaction) => {
      state.simulationTransaction = transaction;
      return {
        context: { slot: 450 },
        value: {
          err: state.simulationError,
          logs: [],
          accounts: [{ ...state.account, owner: CORE_PROGRAM.toBase58(), data: [state.account.data.toString('base64'), 'base64'] }],
        },
      };
    },
    getFeeForMessage: async () => ({ context: { slot: 450 }, value: 10_000 }),
    getBlockHeight: async () => state.height,
    sendRawTransaction: async (bytes: Uint8Array) => {
      assert.ok(existsSync(journalPath), 'the recovery journal must exist before broadcasting');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const tx = VersionedTransaction.deserialize(bytes);
      state.signature = bs58.encode(tx.signatures[0]);
      assert.equal(journal.transactionSignature, state.signature);
      state.sends += 1;
      state.collectionVisible = true;
      return state.signature;
    },
    confirmTransaction: async (_strategy: unknown, commitment: string) => {
      assert.equal(commitment, 'finalized');
      state.confirmations += 1;
      if (state.confirmationError) throw state.confirmationError;
      return { context: { slot: state.finalizedSlot }, value: { err: state.confirmationValueError } };
    },
  };
  const logs: string[] = [];
  const dependencies: PreorderCollectionDeployDependencies = {
    createConnection: (url) => {
      assert.equal(url, raw.solanaRpcUrl);
      return rpc as unknown as Connection;
    },
    fetch: async () => new Response(JSON.stringify(metadata)),
    promptPrivateKey: async () => {
      state.prompts += 1;
      return bs58.encode(payer.secretKey);
    },
    confirm: async () => state.approval,
    log: (message) => logs.push(message),
    now: () => FIXED_DATE,
    generateCollection: () => {
      state.generated += 1;
      return collection;
    },
  };
  const run = (overrides: Partial<PreorderCollectionDeployDependencies> = {}) => runPreorderCollectionDeployment(
    { root, collectionId: raw.collectionId }, { ...dependencies, ...overrides },
  );
  return { root, raw, config, collection, payer, account, state, rpc, metadata, dependencies, logs, run, writeConfig, recordPath, journalPath, lockPath };
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('preorder command accepts one collection ID or help and rejects unsafe arguments', () => {
  assert.equal(parsePreorderCollectionArgs(['mi_note_cards']), 'mi_note_cards');
  assert.equal(parsePreorderCollectionArgs(['--help']), null);
  for (const args of [[], ['../mi_note_cards'], ['mi_note_cards.ts'], ['--mainnet'], ['one', 'two']]) {
    assert.throws(() => parsePreorderCollectionArgs(args));
  }
});

test('preorder metadata preflight checks every declared metadata field and creator share', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => assertPreorderCollectionMetadata(f.config, f.metadata));
  for (const [key, value] of Object.entries(f.metadata)) {
    const changed = { ...f.metadata, [key]: typeof value === 'number' ? 0 : 'mismatch' };
    assert.throws(() => assertPreorderCollectionMetadata(f.config, changed), /metadata|mismatch|collection.json/i);
  }
  assert.throws(() => assertPreorderCollectionMetadata(f.config, {
    ...f.metadata, properties: { creators: [{ address: f.config.authority, share: 99 }] },
  }), /creators/i);
  for (const invalid of [null, [], 'metadata']) {
    assert.throws(() => assertPreorderCollectionMetadata(f.config, invalid));
  }
});

test('preorder account validation accepts only the intended mutable collection and plugins', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => validatePreorderCollectionAccount({ config: f.config, account: f.account }));
  const invalidAccounts = [
    null,
    { ...f.account, owner: SystemProgram.programId },
    { ...f.account, executable: true },
    { ...f.account, data: Buffer.alloc(20) },
    collectionAccount(f.config, { authority: f.collection.publicKey }),
    collectionAccount(f.config, { name: 'Wrong collection' }),
    collectionAccount(f.config, { uri: 'https://example.com/wrong.json' }),
    collectionAccount(f.config, { delegates: [] }),
    collectionAccount(f.config, { delegates: [f.payer.publicKey, f.collection.publicKey] }),
    collectionAccount(f.config, { delegateAuthority: 0 }),
    collectionAccount(f.config, { royaltiesAuthority: 0 }),
    collectionAccount(f.config, { basisPoints: 501 }),
    collectionAccount(f.config, { share: 99 }),
    collectionAccount(f.config, { ruleSet: 1 }),
    collectionAccount(f.config, { omitBubblegum: true }),
    collectionAccount(f.config, { extraPlugin: 12 }),
  ];
  for (const account of invalidAccounts) {
    assert.throws(() => validatePreorderCollectionAccount({ config: f.config, account }));
  }
});

test('preorder deployment persists public finalized information and signs creation with both keys', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.ok(result);
  assert.equal(result.collectionMint, f.collection.publicKey.toBase58());
  assert.equal(result.transactionSignature, f.state.signature);
  assert.equal(result.deployedAt, FIXED_DATE.toISOString());
  assert.equal(result.finalizedSlot, f.state.finalizedSlot);
  assert.deepEqual(readJson(f.recordPath), result);
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.confirmations, 1);
  assert.equal(f.state.prompts, 1);
  assert.equal(f.state.generated, 1);
  assert.equal(existsSync(f.journalPath), false);
  assert.equal(existsSync(f.lockPath), false);
  assert.ok(f.state.accountReads.some((options) => options.minContextSlot === f.state.finalizedSlot));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private-api-key'), false);
  assert.equal(serialized.includes(bs58.encode(f.payer.secretKey)), false);
  assert.equal(serialized.includes(bs58.encode(f.collection.secretKey)), false);
  assert.ok(f.logs.some((message) => message.includes(`coreCollectionPubkey: '${result.collectionMint}'`)));
  const tx = f.state.simulationTransaction;
  assert.ok(tx);
  assert.equal(tx.signatures.length, 2);
  assert.ok(tx.signatures.every((signature) => signature.some((byte) => byte !== 0)));
  assert.equal(tx.message.compiledInstructions.length, 1);
  const create = tx.message.compiledInstructions[0];
  assert.ok(tx.message.staticAccountKeys[create.programIdIndex].equals(CORE_PROGRAM));
  const expected = buildCreateMplCoreCollectionV2Ix({
    collection: f.collection.publicKey, updateAuthority: f.payer.publicKey,
    updateDelegates: [f.payer.publicKey], payer: f.payer.publicKey,
    systemProgram: SystemProgram.programId, name: f.config.collectionMetadata.name,
    uri: f.config.collectionMetadataUri, royaltiesBps: 500,
    royaltiesCreators: [{ address: f.payer.publicKey, percentage: 100 }], royaltiesAuthority: null,
  });
  assert.deepEqual(Buffer.from(create.data), expected.data);
});

test('preorder accepts a JSON-array private key', async (t) => {
  const f = fixture(t);
  await f.run({ promptPrivateKey: async () => JSON.stringify([...f.payer.secretKey]) });
  assert.equal(f.state.sends, 1);
});

test('unfinished configuration and metadata errors fail before requesting a key', async (t) => {
  const f = fixture(t);
  f.writeConfig({ ...f.raw, authority: 'TODO' });
  await assert.rejects(f.run, /authority/i);
  assert.equal(f.state.prompts, 0);
  f.writeConfig();
  await assert.rejects(() => f.run({ fetch: async () => new Response('{}') }), /metadata|mismatch|collection.json/i);
  assert.equal(f.state.prompts, 0);
  assert.equal(f.state.sends, 0);
});

test('wrong RPC cluster and nonexecutable Core program never request a key or broadcast', async (t) => {
  const f = fixture(t);
  f.state.genesis = 'wrong-cluster';
  await assert.rejects(f.run, /genesis|cluster/i);
  f.state.genesis = MAINNET_GENESIS;
  f.state.executable = false;
  await assert.rejects(f.run, /executable|unavailable/i);
  assert.equal(f.state.prompts, 0);
  assert.equal(f.state.sends, 0);
});

test('a private key for the wrong authority cannot deploy', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.run({ promptPrivateKey: async () => bs58.encode(f.collection.secretKey) }), /authority|match/i);
  assert.equal(f.state.sends, 0);
  assert.equal(existsSync(f.journalPath), false);
});

test('cancelling confirmation produces no journal or deployment', async (t) => {
  const f = fixture(t);
  f.state.approval = false;
  assert.equal(await f.run(), null);
  assert.equal(f.state.sends, 0);
  assert.equal(existsSync(f.recordPath), false);
  assert.equal(existsSync(f.journalPath), false);
  assert.equal(existsSync(f.lockPath), false);
});

test('failed simulation and malformed simulated collection never broadcast', async (t) => {
  const f = fixture(t);
  f.state.simulationError = { InstructionError: [0, 'InsufficientFunds'] };
  await assert.rejects(f.run, /simulat/i);
  f.state.simulationError = null;
  f.state.account = collectionAccount(f.config, { delegates: [] });
  await assert.rejects(f.run, /delegate/i);
  assert.equal(f.state.sends, 0);
  assert.equal(existsSync(f.journalPath), false);
});

test('expiry during confirmation cannot send an already-expired transaction', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.run({ confirm: async () => {
    f.state.height = 201;
    return true;
  } }), /expir|blockhash/i);
  assert.equal(f.state.sends, 0);
  assert.equal(existsSync(f.recordPath), false);
});

test('post-send timeout preserves only a public recovery journal', async (t) => {
  const f = fixture(t);
  f.state.confirmationError = new Error('confirmation timed out');
  await assert.rejects(f.run, /timed out/);
  assert.equal(f.state.sends, 1);
  assert.equal(existsSync(f.recordPath), false);
  assert.equal(existsSync(f.journalPath), true);
  assert.equal(existsSync(f.lockPath), false);
  const journal = readJson(f.journalPath);
  assert.equal(journal.collectionMint, f.collection.publicKey.toBase58());
  assert.equal(journal.transactionSignature, f.state.signature);
  const serialized = JSON.stringify(journal);
  assert.equal(serialized.includes('private-api-key'), false);
  assert.equal(serialized.includes(bs58.encode(f.payer.secretKey)), false);
  assert.equal(serialized.includes(bs58.encode(f.collection.secretKey)), false);
});

test('an interrupted finalized mint recovers its original address without keys or another send', async (t) => {
  const f = fixture(t);
  f.state.confirmationError = new Error('confirmation timed out');
  await assert.rejects(f.run);
  const result = await f.run({
    promptPrivateKey: async () => { throw new Error('recovery must not request a key'); },
    generateCollection: () => { throw new Error('recovery must not generate a new address'); },
  });
  assert.equal(result?.collectionMint, f.collection.publicKey.toBase58());
  assert.equal(f.state.sends, 1);
  assert.equal(existsSync(f.journalPath), false);
  assert.ok(existsSync(f.recordPath));
});

test('an existing verified deployment is a no-op without keys or new transactions', async (t) => {
  const f = fixture(t);
  const original = await f.run();
  const result = await f.run({
    promptPrivateKey: async () => { throw new Error('existing deployment must not request a key'); },
    generateCollection: () => { throw new Error('existing deployment must not generate a new address'); },
  });
  assert.deepEqual(result, original);
  assert.equal(f.state.sends, 1);
});

test('an unresolved prior transaction blocks replacement and preserves its journal', async (t) => {
  const f = fixture(t);
  f.state.confirmationError = new Error('confirmation timed out');
  await assert.rejects(f.run);
  const pending = readFileSync(f.journalPath, 'utf8');
  f.state.collectionVisible = false;
  f.state.signatureStatus = null;
  await assert.rejects(f.run, /pending|expir|unresolved|not.*final/i);
  assert.equal(readFileSync(f.journalPath, 'utf8'), pending);
  assert.equal(f.state.generated, 1);
  assert.equal(f.state.sends, 1);
});

test('a confirmed transaction still blocks replacement even after the blockhash expires', async (t) => {
  const f = fixture(t);
  f.state.confirmationError = new Error('confirmation timed out');
  await assert.rejects(f.run);
  f.state.collectionVisible = false;
  f.state.signatureStatus = 'confirmed';
  f.state.height = 201;
  await assert.rejects(f.run, /pending|final|unresolved/i);
  assert.equal(f.state.generated, 1);
  assert.equal(f.state.sends, 1);
  assert.ok(existsSync(f.journalPath));
});

test('an expired missing transaction can start over only after finalized account absence', async (t) => {
  const f = fixture(t);
  f.state.confirmationError = new Error('confirmation timed out');
  await assert.rejects(f.run);
  f.state.collectionVisible = false;
  f.state.signatureStatus = null;
  f.state.height = 201;
  f.state.confirmationError = null;
  f.rpc.getLatestBlockhash = async () => ({ blockhash: f.collection.publicKey.toBase58(), lastValidBlockHeight: 300 });
  await f.run();
  assert.equal(f.state.generated, 2);
  assert.equal(f.state.sends, 2);
  assert.ok(f.state.accountReads.some((options) => options.minContextSlot === f.state.finalizedSlot));
  assert.equal(existsSync(f.journalPath), false);
  assert.ok(existsSync(f.recordPath));
});

test('a finalized transaction with an invalid resulting collection cannot be committed', async (t) => {
  const f = fixture(t);
  const originalConfirm = f.rpc.confirmTransaction;
  f.rpc.confirmTransaction = async (strategy, commitment) => {
    f.state.account = collectionAccount(f.config, { name: 'Unexpected collection' });
    return originalConfirm(strategy, commitment);
  };
  await assert.rejects(f.run, /name|metadata|match/i);
  assert.equal(existsSync(f.recordPath), false);
  assert.ok(existsSync(f.journalPath));
});

test('an existing deployment with conflicting configuration is never overwritten', async (t) => {
  const f = fixture(t);
  await f.run();
  const record = readJson(f.recordPath);
  (record.config as Record<string, unknown>).authority = f.collection.publicKey.toBase58();
  const conflicting = JSON.stringify(record);
  writeFileSync(f.recordPath, conflicting);
  await assert.rejects(f.run, /config|conflict|match/i);
  assert.equal(readFileSync(f.recordPath, 'utf8'), conflicting);
  assert.equal(f.state.sends, 1);
});

test('a record appearing after broadcast is preserved and leaves the recovery journal intact', async (t) => {
  const f = fixture(t);
  const conflicting = '{"conflicting":"deployment"}';
  const originalConfirm = f.rpc.confirmTransaction;
  f.rpc.confirmTransaction = async (strategy, commitment) => {
    mkdirSync(path.dirname(f.recordPath), { recursive: true });
    writeFileSync(f.recordPath, conflicting);
    return originalConfirm(strategy, commitment);
  };
  await assert.rejects(f.run);
  assert.equal(readFileSync(f.recordPath, 'utf8'), conflicting);
  assert.ok(existsSync(f.journalPath));
});

test('simultaneous invocations cannot deploy the same collection ID', async (t) => {
  const f = fixture(t);
  let releasePrompt!: (key: string) => void;
  let enteredPrompt!: () => void;
  const entered = new Promise<void>((resolve) => { enteredPrompt = resolve; });
  const first = f.run({
    promptPrivateKey: () => new Promise<string>((resolve) => {
      releasePrompt = resolve;
      enteredPrompt();
    }),
    confirm: async () => false,
  });
  await entered;
  try {
    await assert.rejects(f.run, /lock|running|progress/i);
    assert.ok(existsSync(f.lockPath));
  } finally {
    releasePrompt(bs58.encode(f.payer.secretKey));
    await first;
  }
  assert.equal(existsSync(f.lockPath), false);
  assert.equal(f.state.sends, 0);
});


test('existing deployment verification rejects stale finalized account context', async (t) => {
  const f = fixture(t);
  await f.run();
  const record = readFileSync(f.recordPath, 'utf8');
  f.state.finalizedSlot -= 1;
  await assert.rejects(f.run, /stale|slot/i);
  assert.equal(readFileSync(f.recordPath, 'utf8'), record);
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.prompts, 1);
});

test('metadata changed while awaiting confirmation prevents broadcast', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.run({ confirm: async () => {
    f.metadata.image = 'https://assets.example.com/changed.png';
    return true;
  } }), /image/);
  assert.equal(f.state.sends, 0);
  assert.equal(existsSync(f.journalPath), false);
});

test('a failed finalized transaction preserves recovery information without a deployment record', async (t) => {
  const f = fixture(t);
  f.state.confirmationValueError = { InstructionError: [0, 'Custom'] };
  await assert.rejects(f.run, /failed/i);
  assert.equal(f.state.sends, 1);
  assert.ok(existsSync(f.journalPath));
  assert.equal(existsSync(f.recordPath), false);
});
