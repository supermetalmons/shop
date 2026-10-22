import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Keypair, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  runWorkerTransaction, type WorkerTransactionJournal, type WorkerTransactionOperation,
} from '../scripts/ops/worker-transaction/index.ts';
import { createWorkerTransactionSigner } from '../scripts/ops/worker-transaction/signer.ts';
import { type createWorkerVersionClient, type TemporaryWorkerVersion, type WorkerSnapshot } from '../scripts/ops/worker-transaction/cloudflare.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worker-transaction-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const target = { accountId: 'a'.repeat(32), workerName: 'test-api' };
  const versionId = randomUUID();
  const snapshot: WorkerSnapshot = { deploymentId: randomUUID(), versionId, latestVersionId: versionId, previewSuffix: 'test-api.test.workers.dev',
    compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'], secretNames: ['COSIGNER_SECRET'] };
  const state = { sends: 0, uploads: 0, blockhashReads: 0, blockHeight: 150, simulations: [] as boolean[], events: [] as string[], confirmed: false,
    balance: 1, failPreflight: false, failVerify: false, failCleanup: false, failBroadcast: false, uploadMode: 'ok' as 'ok' | 'unknown' | 'rejected',
    visible: false, productionUnchanged: true, simulationAccounts: [] as string[][],
    version: undefined as TemporaryWorkerVersion | undefined, bundle: '', signature: '' };
  const directory = path.join(root, '.cache/worker-transactions/test-transfer');
  const journalPath = path.join(directory, 'journal.json');
  const journal = () => JSON.parse(readFileSync(journalPath, 'utf8')) as WorkerTransactionJournal;
  const connection = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getLatestBlockhashAndContext: async () => {
      state.blockhashReads++;
      return { context: { slot: 100 }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 } };
    },
    simulateTransaction: async (_transaction: VersionedTransaction, options: { sigVerify: boolean; minContextSlot: number; accounts?: { addresses: string[] } }) => {
      state.simulations.push(options.sigVerify);
      state.simulationAccounts.push([...(options.accounts?.addresses ?? [])]);
      return { context: { slot: options.minContextSlot }, value: { err: null, logs: [], unitsConsumed: 500, accounts: [] } };
    },
    getFeeForMessage: async () => ({ value: 5000 }),
    getSignatureStatuses: async () => ({ value: [state.confirmed ? { err: null, confirmationStatus: 'finalized', slot: 110 } : null] }),
    getBlockHeight: async () => state.blockHeight,
    sendRawTransaction: async (bytes: Uint8Array) => {
      const saved = journal();
      assert.equal(Buffer.from(bytes).toString('base64'), saved.signed?.transactionBase64);
      const transaction = VersionedTransaction.deserialize(bytes);
      assert.equal(Buffer.from(transaction.message.serialize()).toString('base64'), JSON.parse(state.bundle).messageBase64);
      state.events.push('broadcast'); state.sends++;
      if (state.failBroadcast) throw new Error('Broadcast response unavailable');
      state.confirmed = true;
      return saved.signed!.signature;
    },
    getTransaction: async () => ({ meta: { err: null, fee: 5000 } }),
  } as unknown as Connection;
  const operation: WorkerTransactionOperation = {
    id: 'test-transfer', cluster: 'devnet', authority: payer.publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1 })],
    simulationAccounts: [recipient.toBase58()],
    preflight: async () => { state.events.push('preflight'); if (state.failPreflight) throw new Error('Business precondition unavailable'); },
    validateSimulation: result => { state.events.push('validate'); assert.equal(result.err, null); assert.equal(result.unitsConsumed, 500); },
    verify: async (_connection, slot) => {
      state.events.push('verify'); assert.equal(slot, 110);
      if (state.failVerify) throw new Error('Final verification unavailable');
      assert.ok(state.balance >= 1);
    },
  };
  const client = {
    snapshot: async () => { state.events.push('snapshot'); return snapshot; },
    assertUnchanged: async () => { state.events.push('unchanged'); },
    upload: async (options: { bundle: string; operationId: string; onUploadChange: (started: boolean) => void }) => {
      state.events.push('upload'); state.uploads++; state.bundle = options.bundle;
      options.onUploadChange(true); assert.equal(journal().uploadStarted, true);
      if (state.uploadMode === 'rejected') { options.onUploadChange(false); throw new Error('Cloudflare rejected upload'); }
      state.version = { id: randomUUID(), url: 'https://temporary-test-api.test.workers.dev', operationId: options.operationId };
      if (state.uploadMode === 'unknown') throw new Error('Cloudflare upload response lost');
      return state.version;
    },
    findOperation: async () => { state.events.push('discover'); return state.visible && state.version ? [state.version] : []; },
    remove: async () => { state.events.push('remove'); if (state.failCleanup) throw new Error('Cleanup unavailable'); },
    verifyRemoved: async () => { state.events.push('removed'); return { absent: true, previewStatus: 404, productionUnchanged: state.productionUnchanged }; },
  } as unknown as ReturnType<typeof createWorkerVersionClient>;
  const dependencies = { connection, client,
    bundle: async (config: Parameters<typeof createWorkerTransactionSigner>[0]) => JSON.stringify(config),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      state.events.push('sign');
      const response = await createWorkerTransactionSigner(JSON.parse(state.bundle)).fetch(new Request(input, init), {
        COSIGNER_SECRET: bs58.encode(payer.secretKey),
      });
      if (response.ok) state.signature = (await response.clone().json()).signature;
      return response;
    },
    wait: async () => {},
  };
  const run = (write = false, selected = operation) => runWorkerTransaction(selected, { root, cloudflare: target, write }, dependencies);
  return { root, target, payer, recipient, state, operation, dependencies, run, journal, journalPath,
    receiptPath: path.join(directory, 'receipt.json'), lockPath: path.join(root, '.cache/worker-transactions/locks', `${target.accountId}-${target.workerName}.lock`) };
}

test('default invocation only validates and simulates without Cloudflare, signing, or files', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.mode, 'preflight');
  assert.deepEqual(f.state.events, ['preflight', 'validate']);
  assert.deepEqual(f.state.simulations, [false]);
  assert.equal(f.state.sends, 0); assert.equal(f.state.uploads, 0);
  assert.equal(existsSync(path.join(f.root, '.cache')), false);
});

test('explicit write freezes one message, journals it before broadcast and saves verified cleanup receipt', async t => {
  const f = fixture(t);
  const result = await f.run(true);
  assert.equal(result.mode, 'complete');
  assert.deepEqual(f.state.simulations, [false, true]);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
  assert.ok(f.state.events.indexOf('broadcast') < f.state.events.indexOf('verify'));
  assert.ok(f.state.events.indexOf('verify') < f.state.events.indexOf('remove'));
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(receipt.signature, f.state.signature); assert.equal(receipt.finalizedSlot, 110);
  assert.equal(receipt.feeLamports, 5000); assert.equal(receipt.worker.absent, true);
  assert.equal(f.journal().cleanup?.productionUnchanged, true);
  assert.equal(existsSync(f.lockPath), false);
});

test('preflight instruction replacement cannot change the recorded intent or signed transfer', async t => {
  const f = fixture(t);
  const original = { ...f.operation };
  f.operation.preflight = async connection => {
    await original.preflight(connection);
    f.operation.instructions = [SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: f.recipient, lamports: 2 })];
  };
  const result = await f.run(true);
  assert.equal(result.mode, 'complete');
  const transaction = VersionedTransaction.deserialize(Buffer.from(f.journal().signed!.transactionBase64, 'base64'));
  const instruction = TransactionMessage.decompile(transaction.message).instructions[0];
  assert.equal(SystemInstruction.decodeTransfer(instruction).lamports, 1n);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(receipt.intent.instructions[0].data, instruction.data.toString('base64'));
  assert.equal((await f.run(false, original)).mode, 'verified');
  assert.equal(f.state.sends, 1); assert.equal(f.state.uploads, 1);
});

test('pins nested instruction data, account metadata, simulation accounts, fee policy, and callbacks across awaits', async t => {
  const f = fixture(t);
  f.operation.maxFeeLamports = 5000;
  const original = { ...f.operation,
    instructions: [SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: f.recipient, lamports: 1 })],
    simulationAccounts: [...f.operation.simulationAccounts],
  };
  const replacement = Keypair.generate().publicKey;
  f.operation.preflight = async connection => {
    await original.preflight(connection);
    const instruction = f.operation.instructions[0];
    instruction.data.writeBigUInt64LE(2n, 4);
    instruction.keys[1].pubkey = replacement;
    instruction.keys[1].isWritable = false;
    f.operation.simulationAccounts[0] = replacement.toBase58();
    f.operation.maxFeeLamports = 1;
    f.operation.validateSimulation = () => assert.fail('Replaced simulation validator ran');
    f.operation.verify = async () => assert.fail('Replaced final verifier ran');
  };
  assert.equal((await f.run(true)).mode, 'complete');
  const transaction = VersionedTransaction.deserialize(Buffer.from(f.journal().signed!.transactionBase64, 'base64'));
  const instruction = TransactionMessage.decompile(transaction.message).instructions[0];
  const transfer = SystemInstruction.decodeTransfer(instruction);
  assert.equal(transfer.lamports, 1n);
  assert.equal(transfer.toPubkey.toBase58(), f.recipient.toBase58());
  assert.equal(instruction.keys[1].isWritable, true);
  assert.deepEqual(f.state.simulationAccounts, [[f.recipient.toBase58()], [f.recipient.toBase58()]]);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(receipt.intent.instructions[0].data, instruction.data.toString('base64'));
  assert.equal(receipt.intent.instructions[0].keys[1].address, f.recipient.toBase58());
  assert.equal(receipt.intent.instructions[0].keys[1].isWritable, true);
  assert.deepEqual(receipt.intent.simulationAccounts, original.simulationAccounts);
  assert.equal(receipt.intent.maxFeeLamports, 5000);
  assert.equal((await f.run(false, original)).mode, 'verified');
  assert.equal(f.state.sends, 1); assert.equal(f.state.uploads, 1);
});

test('changed input cleans an existing pending signer before refusing another transaction', async t => {
  const f = fixture(t);
  f.state.failVerify = true; f.state.failCleanup = true;
  await assert.rejects(f.run(true), /Cleanup unavailable/);
  assert.ok(f.journal().signed); assert.equal(f.journal().cleanup, undefined);
  f.state.failCleanup = false; f.state.events.length = 0;
  const changed = { ...f.operation, instructions: [SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: f.recipient, lamports: 2 })] };
  await assert.rejects(f.run(true, changed), /input differs/);
  assert.deepEqual(f.state.events, ['remove', 'removed']);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
  assert.equal(f.journal().cleanup?.absent, true);
});

test('finalized recovery runs the domain verifier against current state without redoing preflight or sending', async t => {
  const f = fixture(t);
  f.state.failVerify = true;
  await assert.rejects(f.run(true), /Final verification unavailable/);
  assert.equal(f.journal().finalized, undefined); assert.equal(f.journal().cleanup?.absent, true);
  f.state.failVerify = false; f.state.failPreflight = true; f.state.balance = 7; f.state.events.length = 0;
  const result = await f.run(true);
  assert.equal(result.mode, 'complete');
  assert.deepEqual(f.state.events, ['verify']);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
  assert.deepEqual(f.state.simulations, [false, true]);
  assert.equal((await f.run()).mode, 'verified');
});

test('finalized recovery records successful cleanup after an unrelated production deployment', async t => {
  const f = fixture(t);
  f.state.failCleanup = true;
  await assert.rejects(f.run(true), /Cleanup unavailable/);
  assert.ok(f.journal().finalized); assert.equal(f.journal().cleanup, undefined);
  f.state.failCleanup = false; f.state.productionUnchanged = false; f.state.events.length = 0;
  const result = await f.run(true);
  assert.equal(result.mode, 'complete');
  assert.deepEqual(f.state.events, ['remove', 'removed', 'verify']);
  assert.equal(f.journal().cleanup?.absent, true);
  assert.equal(f.journal().cleanup?.productionUnchanged, false);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(receipt.worker.productionUnchanged, false);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
});

test('uncertain upload remains pending with no duplicate POST until its version is discoverable', async t => {
  const f = fixture(t);
  f.state.uploadMode = 'unknown';
  await assert.rejects(f.run(true), /outcome is unresolved/);
  const attempt = f.journal().attemptId;
  assert.equal(f.journal().uploadStarted, true); assert.equal(f.journal().signed, undefined);
  f.state.uploadMode = 'ok';
  await assert.rejects(f.run(true), /outcome is unresolved/);
  assert.equal(f.state.uploads, 1); assert.equal(f.journal().attemptId, attempt);
  f.state.visible = true;
  assert.equal((await f.run(true)).mode, 'complete');
  assert.equal(f.state.uploads, 2); assert.equal(f.state.sends, 1);
});

test('definitively rejected upload remains unsubmitted and a corrected retry can proceed', async t => {
  const f = fixture(t);
  f.state.uploadMode = 'rejected';
  await assert.rejects(f.run(true), /rejected upload/);
  assert.equal(f.journal().uploadStarted, false);
  assert.equal(f.state.events.includes('discover'), false);
  f.state.uploadMode = 'ok';
  assert.equal((await f.run(true)).mode, 'complete');
  assert.equal(f.state.uploads, 2); assert.equal(f.state.sends, 1);
});

test('stale lock reports its owner and preserves existing recovery evidence', async t => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.lockPath), { recursive: true });
  writeFileSync(f.lockPath, '1234567');
  await assert.rejects(f.run(true), error => error instanceof Error && /1234567/.test(error.message) && /stopped/.test(error.message) && /preserve all journals/.test(error.message));
  assert.equal(readFileSync(f.lockPath, 'utf8'), '1234567');
  assert.deepEqual(f.state.events, []);
});

test('resume rejects a different Worker or signer binding after cleaning the saved version', async t => {
  for (const changed of [{ cloudflare: { accountId: 'b'.repeat(32), workerName: 'other-api' } }, { signerBinding: 'OTHER_KEY' }]) {
    const f = fixture(t);
    f.state.failVerify = true; f.state.failCleanup = true;
    await assert.rejects(f.run(true), /Cleanup unavailable/);
    f.state.failCleanup = false; f.state.events.length = 0;
    await assert.rejects(runWorkerTransaction(f.operation, { root: f.root, write: true, ...changed }, f.dependencies), /target or signer binding differs/);
    assert.deepEqual(f.state.events, ['remove', 'removed']);
    assert.equal(f.journal().cleanup?.absent, true);
    assert.equal(f.state.sends, 1); assert.equal(f.state.uploads, 1);
  }
});

test('operation lock cannot be bypassed by choosing a different Worker target', async t => {
  const f = fixture(t);
  const lock = path.join(path.dirname(f.journalPath), 'operation.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, '7654321');
  await assert.rejects(runWorkerTransaction(f.operation, { root: f.root, write: true,
    cloudflare: { accountId: 'b'.repeat(32), workerName: 'other-api' } }, f.dependencies), /7654321/);
  assert.equal(readFileSync(lock, 'utf8'), '7654321');
  assert.deepEqual(f.state.events, []);
});

test('unresolved cleanup blocks another operation on the same Worker until the original resumes', async t => {
  const f = fixture(t);
  f.state.failCleanup = true;
  await assert.rejects(f.run(true), /Cleanup unavailable/);
  const pending = readFileSync(f.journalPath, 'utf8');
  const next = { ...f.operation, id: 'second-transfer', preflight: async () => { throw new Error('Next operation reached preflight'); } };
  const runNext = () => runWorkerTransaction(next, { root: f.root, write: true,
    cloudflare: { ...f.target, accountId: f.target.accountId.toUpperCase() } }, f.dependencies);
  f.state.failCleanup = false; f.state.events.length = 0;
  await assert.rejects(runNext(), error => error instanceof Error && /unresolved Worker cleanup/i.test(error.message) && error.message.includes(f.operation.id));
  assert.deepEqual(f.state.events, []);
  assert.equal(readFileSync(f.journalPath, 'utf8'), pending);
  assert.deepEqual(f.state.simulations, [false, true]);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
  assert.equal((await f.run(true)).mode, 'complete');
  f.state.events.length = 0;
  await assert.rejects(runNext(), /Next operation reached preflight/);
  assert.deepEqual(f.state.events, ['snapshot']);
  assert.equal(f.journal().cleanup?.absent, true);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
});

test('unresolved cleanup on another Worker does not block a new operation', async t => {
  const f = fixture(t);
  f.state.failCleanup = true;
  await assert.rejects(f.run(true), /Cleanup unavailable/);
  const pending = readFileSync(f.journalPath, 'utf8');
  f.state.events.length = 0;
  const next = { ...f.operation, id: 'other-worker-transfer', preflight: async () => { throw new Error('Other Worker preflight reached'); } };
  await assert.rejects(runWorkerTransaction(next, { root: f.root, write: true,
    cloudflare: { ...f.target, workerName: 'other-api' } }, f.dependencies), /Other Worker preflight reached/);
  assert.deepEqual(f.state.events, ['snapshot']);
  assert.equal(readFileSync(f.journalPath, 'utf8'), pending);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
});

test('a definitively rejected unsubmitted upload does not block a different operation on the same Worker', async t => {
  const f = fixture(t);
  f.state.uploadMode = 'rejected';
  await assert.rejects(f.run(true), /rejected upload/);
  assert.equal(f.journal().uploadStarted, false);
  const pending = readFileSync(f.journalPath, 'utf8');
  f.state.events.length = 0;
  const next = { ...f.operation, id: 'next-transfer', preflight: async () => { throw new Error('Next operation preflight reached'); } };
  await assert.rejects(f.run(true, next), /Next operation preflight reached/);
  assert.deepEqual(f.state.events, ['snapshot']);
  assert.equal(readFileSync(f.journalPath, 'utf8'), pending);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 0);
});

test('read-only verification rejects corrupted signatures and unconfirmed recorded finalization', async t => {
  const f = fixture(t);
  await f.run(true);
  const original = f.journal();
  for (const field of ['signature', 'transactionBase64'] as const) {
    const corrupted = structuredClone(original);
    if (field === 'signature') corrupted.signed!.signature = bs58.encode(Buffer.alloc(64, 1));
    else {
      const bytes = Buffer.from(corrupted.signed!.transactionBase64, 'base64');
      bytes[5] ^= 1; corrupted.signed!.transactionBase64 = bytes.toString('base64');
    }
    const source = JSON.stringify(corrupted);
    writeFileSync(f.journalPath, source); f.state.events.length = 0;
    await assert.rejects(f.run(), /identity mismatch|invalid authority signature/);
    assert.equal(readFileSync(f.journalPath, 'utf8'), source);
    assert.deepEqual(f.state.events, []);
  }
  writeFileSync(f.journalPath, JSON.stringify(original)); f.state.confirmed = false;
  await assert.rejects(f.run(), /finalization is not confirmed/);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.sends, 1);
  assert.deepEqual(f.state.events, []);
});

test('expired signed pending transaction is preserved without a fresh upload, blockhash, or send', async t => {
  const f = fixture(t);
  f.state.failBroadcast = true;
  await assert.rejects(f.run(true), /Finalization is not established/);
  assert.ok(f.journal().signed); assert.equal(f.journal().cleanup?.absent, true);
  const pending = readFileSync(f.journalPath, 'utf8');
  f.state.blockHeight = 201; f.state.failBroadcast = false; f.state.events.length = 0;
  await assert.rejects(f.run(true), /expired without confirmation/);
  assert.equal(readFileSync(f.journalPath, 'utf8'), pending);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.blockhashReads, 1); assert.equal(f.state.sends, 1);
  assert.deepEqual(f.state.events, []);
  assert.deepEqual(f.state.simulations, [false, true]);
});
