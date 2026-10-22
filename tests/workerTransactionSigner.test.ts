import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Keypair, MessageV0, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';
import { createWorkerTransactionSigner } from '../scripts/ops/worker-transaction/signer.ts';
import { createWorkerVersionClient } from '../scripts/ops/worker-transaction/cloudflare.ts';
import { assertSignedTransaction, assertUnsignedTransaction, buildCollectionUriUpdate, buildTransaction } from '../scripts/ops/worker-transaction/transaction.ts';

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

test('builds URI-only Core updates for independent collections without imposing metadata-host policy', () => {
  const authority = Keypair.generate();
  const collections = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const uris = ['https://assets.example.com/collection.json', 'ipfs://example-collection/metadata.json'];
  const messages = collections.map((collection, index) => {
    const instruction = buildCollectionUriUpdate({ collection: collection.toBase58(), authority: authority.publicKey.toBase58(), uri: uris[index] });
    assert.equal(instruction.programId.toBase58(), MPL_CORE_PROGRAM_ADDRESS);
    assert.deepEqual([...instruction.data.subarray(0, 3)], [16, 0, 1]);
    assert.equal(instruction.data.readUInt32LE(3), Buffer.byteLength(uris[index]));
    assert.equal(instruction.data.subarray(7).toString(), uris[index]);
    assert.deepEqual(instruction.keys.map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable]), [
      [collection.toBase58(), false, true], [authority.publicKey.toBase58(), true, true], [authority.publicKey.toBase58(), true, false],
      [MPL_CORE_PROGRAM_ADDRESS, false, false], [SystemProgram.programId.toBase58(), false, false], [MPL_CORE_PROGRAM_ADDRESS, false, false],
    ]);
    return buildTransaction(authority.publicKey.toBase58(), [instruction], SystemProgram.programId.toBase58()).message.serialize();
  });
  assert.notDeepEqual(messages[0], messages[1]);
  assert.throws(() => buildCollectionUriUpdate({ collection: collections[0].toBase58(), authority: authority.publicKey.toBase58(), uri: '' }), /URI is required/);
});

function fixture(operation: 'transfer' | 'memo' = 'transfer') {
  const keypair = Keypair.generate();
  const authority = keypair.publicKey.toBase58();
  const instruction = operation === 'transfer'
    ? SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })
    : new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('offline signer test') });
  const transaction = buildTransaction(authority, [instruction], Keypair.generate().publicKey.toBase58());
  const messageBytes = transaction.message.serialize();
  const token = randomBytes(32).toString('base64url');
  const config = { messageBase64: Buffer.from(messageBytes).toString('base64'), authority, signerBinding: 'TEST_SIGNER',
    tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 };
  const env = { TEST_SIGNER: bs58.encode(keypair.secretKey) };
  const request = (init: RequestInit = {}, pathname = '/sign') => new Request(`https://temporary.workers.dev${pathname}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, ...init,
  });
  return { keypair, transaction, messageBytes, config, env, request, token, instruction };
}

test('signs two independent operation messages and returns only deterministic verifiable signatures', async () => {
  for (const operation of ['transfer', 'memo'] as const) {
    const f = fixture(operation);
    const signer = createWorkerTransactionSigner(f.config);
    let previous: string | undefined;
    for (const body of [undefined, '']) {
      const response = await signer.fetch(f.request({ body }), f.env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const result = await response.json();
      assert.deepEqual(Object.keys(result), ['signature']);
      assert.ok(nacl.sign.detached.verify(f.messageBytes, bs58.decode(result.signature), f.keypair.publicKey.toBytes()));
      f.transaction.addSignature(f.keypair.publicKey, bs58.decode(result.signature));
      assert.equal(assertSignedTransaction(f.transaction, f.messageBytes, f.config.authority), result.signature);
      if (previous) assert.equal(result.signature, previous);
      previous = result.signature;
    }
  }
});

test('rejects wrong authentication, paths, and request-provided content before accessing the secret', async () => {
  const f = fixture();
  const signer = createWorkerTransactionSigner(f.config);
  const env = { get TEST_SIGNER(): string { return assert.fail('Secret accessed for a rejected request'); } };
  for (const [request, status] of [
    [f.request({ headers: {} }), 401],
    [f.request({ headers: { Authorization: `Bearer ${'a'.repeat(43)}` } }), 401],
    [f.request({ method: 'GET' }), 404],
    [f.request({}, '/other'), 404],
    [f.request({}, '/sign?message=replace'), 400],
    [f.request({ body: JSON.stringify({ messageBase64: f.config.messageBase64 }) }), 400],
  ] as const) assert.equal((await signer.fetch(request, env)).status, status);
});

test('accepts a selected JavaScript binding name containing dollar signs', async () => {
  const f = fixture('memo');
  const signer = createWorkerTransactionSigner({ ...f.config, signerBinding: '$Maintenance_key' });
  const response = await signer.fetch(f.request(), { $Maintenance_key: f.env.TEST_SIGNER });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(nacl.sign.detached.verify(f.messageBytes, bs58.decode(result.signature), f.keypair.publicKey.toBytes()));
});

test('expires absolutely within fifteen minutes and checks expiry again after reading the request', async () => {
  const f = fixture();
  const now = Date.now();
  const env = { get TEST_SIGNER(): string { return assert.fail('Secret accessed after expiry'); } };
  const expired = createWorkerTransactionSigner({ ...f.config, expiresAt: now }, { now: () => now });
  assert.equal((await expired.fetch(f.request(), env)).status, 410);
  const excessive = createWorkerTransactionSigner({ ...f.config, expiresAt: now + 900_001 }, { now: () => now });
  assert.equal((await excessive.fetch(f.request(), env)).status, 409);
  let reads = 0;
  const elapsed = createWorkerTransactionSigner({ ...f.config, expiresAt: now + 100 }, { now: () => ++reads < 3 ? now : now + 100 });
  assert.equal((await elapsed.fetch(f.request({ body: '' }), env)).status, 410);
});

test('wrong or missing keys fail without disclosing values, and decoded secret buffers are wiped', async t => {
  const f = fixture();
  const signer = createWorkerTransactionSigner(f.config);
  const invalidKeys: Record<string, string>[] = [{}, { TEST_SIGNER: 'private-invalid-secret' }, { TEST_SIGNER: bs58.encode(Keypair.generate().secretKey) }];
  for (const env of invalidKeys) {
    const response = await signer.fetch(f.request(), env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'signing-failed' });
  }
  const fromSecretKey = Keypair.fromSecretKey;
  let decoded: Uint8Array | undefined;
  t.mock.method(Keypair, 'fromSecretKey', (secret: Uint8Array) => { decoded = secret; return fromSecretKey(secret); });
  assert.equal((await signer.fetch(f.request(), f.env)).status, 200);
  assert.ok(decoded);
  assert.ok(decoded.every(byte => byte === 0));
});

test('validates one unsigned authority payer and rejects additional signers, signatures, and lookup tables', () => {
  const f = fixture();
  assert.doesNotThrow(() => assertUnsignedTransaction(f.transaction, f.config.authority));
  assert.throws(() => assertUnsignedTransaction(f.transaction, Keypair.generate().publicKey.toBase58()), /only signer and payer/);
  const extraSigner = new TransactionInstruction({ programId: MEMO,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) });
  assert.throws(() => buildTransaction(f.config.authority, [extraSigner], f.transaction.message.recentBlockhash), /only signer and payer/);
  const lookup = new VersionedTransaction(MessageV0.deserialize(f.messageBytes));
  lookup.message.addressTableLookups.push({ accountKey: Keypair.generate().publicKey, writableIndexes: [0], readonlyIndexes: [] });
  assert.throws(() => assertUnsignedTransaction(lookup, f.config.authority), /no lookup tables/);
  assert.throws(() => createWorkerTransactionSigner({ ...f.config, messageBase64: Buffer.from(lookup.message.serialize()).toString('base64') }), /no lookup tables/);
  f.transaction.signatures.push(new Uint8Array(64));
  assert.throws(() => assertUnsignedTransaction(f.transaction, f.config.authority), /only signer and payer/);
  f.transaction.signatures.pop();
  f.transaction.sign([f.keypair]);
  assert.throws(() => assertUnsignedTransaction(f.transaction, f.config.authority), /must be unsigned/);
});

test('rejects changed messages and invalid signatures even when the signer and payer match', () => {
  const f = fixture();
  assert.throws(() => assertSignedTransaction(f.transaction, f.messageBytes, f.config.authority), /invalid authority signature/);
  f.transaction.sign([f.keypair]);
  const approved = Uint8Array.from(f.messageBytes);
  approved[approved.length - 2] ^= 1;
  assert.throws(() => assertSignedTransaction(f.transaction, approved, f.config.authority), /differs from the approved/);
  f.transaction.signatures[0][0] ^= 1;
  assert.throws(() => assertSignedTransaction(f.transaction, f.messageBytes, f.config.authority), /invalid authority signature/);
});

test('embedded messages must be canonical bounded v0 messages with the configured authority', () => {
  const f = fixture();
  const legacy = new TransactionMessage({ payerKey: f.keypair.publicKey, recentBlockhash: f.transaction.message.recentBlockhash,
    instructions: [f.instruction] }).compileToLegacyMessage();
  for (const messageBase64 of [
    '', 'not base64', `${f.config.messageBase64}\n`,
    Buffer.concat([Buffer.from(f.messageBytes), Buffer.from([0])]).toString('base64'),
    Buffer.from(legacy.serialize()).toString('base64'), Buffer.alloc(1233).toString('base64'),
  ]) assert.throws(() => createWorkerTransactionSigner({ ...f.config, messageBase64 }));
  assert.throws(() => createWorkerTransactionSigner({ ...f.config, authority: Keypair.generate().publicKey.toBase58() }), /only signer and payer/);
  const large = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.alloc(1200) });
  assert.throws(() => buildTransaction(f.config.authority, [large], f.transaction.message.recentBlockhash));
});

test('uploaded signer runtime works independently of an older production Worker without Node compatibility', async () => {
  const f = fixture('memo');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bundle = await build({
    absWorkingDir: root,
    stdin: { contents: `import {createWorkerTransactionSigner} from './scripts/ops/worker-transaction/signer.ts'; export default createWorkerTransactionSigner(${JSON.stringify(f.config)});`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, external: ['node:*'], logLevel: 'silent',
  });
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
  const { Miniflare } = wranglerRequire('miniflare');
  const versionId = randomUUID();
  const snapshot = { deploymentId: randomUUID(), versionId, latestVersionId: versionId,
    previewSuffix: 'runtime-fixture.test-account.workers.dev', compatibilityDate: '2025-01-01', compatibilityFlags: [], secretNames: ['TEST_SIGNER'] };
  let uploaded: { compatibility_date: string; compatibility_flags: string[]; modules: { content_base64: string }[] } | undefined;
  const api = createWorkerVersionClient({ token: 'mock-token', target: { accountId: 'a'.repeat(32), workerName: 'runtime-fixture' },
    signerBinding: 'TEST_SIGNER', fetch: async (input, init) => {
      const url = new URL(String(input));
      const response = (result: unknown) => Response.json({ success: true, result });
      if (url.pathname.endsWith('/deployments')) return response({ deployments: [{ id: snapshot.deploymentId, versions: [{ version_id: versionId, percentage: 100 }] }] });
      if (url.pathname.endsWith('/latest')) return response({ id: versionId });
      if (url.pathname.endsWith(`/${versionId}`)) return response({ id: versionId, main_module: 'index.js' });
      assert.equal(init?.method, 'POST');
      assert.equal(url.search, '?deploy=false');
      const body = JSON.parse(String(init.body));
      uploaded = body;
      return response({ id: randomUUID(), annotations: body.annotations });
    },
  });
  await api.upload({ snapshot, bundle: bundle.outputFiles[0].text, operationId: randomUUID(), onUploadChange: () => {} });
  assert.ok(uploaded);
  assert.notEqual(uploaded.compatibility_date, snapshot.compatibilityDate);
  const worker = new Miniflare({ modules: true, script: Buffer.from(uploaded.modules[0].content_base64, 'base64').toString(),
    compatibilityDate: uploaded.compatibility_date, compatibilityFlags: uploaded.compatibility_flags, bindings: f.env,
    outboundService: async () => { assert.fail('Signer made an outbound request'); },
  });
  try {
    let previous: string | undefined;
    for (const body of [undefined, '']) {
      const response = await worker.dispatchFetch('https://temporary.workers.dev/sign', {
        method: 'POST', headers: { Authorization: `Bearer ${f.token}` }, body,
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(Object.keys(result), ['signature']);
      assert.ok(nacl.sign.detached.verify(f.messageBytes, bs58.decode(result.signature), f.keypair.publicKey.toBytes()));
      if (previous) assert.equal(result.signature, previous);
      previous = result.signature;
    }
    const rejected = await worker.dispatchFetch('https://temporary.workers.dev/sign', {
      method: 'POST', headers: { Authorization: `Bearer ${f.token}` }, body: '{}',
    });
    assert.equal(rejected.status, 400);
  } finally {
    await worker.dispose();
  }
});
