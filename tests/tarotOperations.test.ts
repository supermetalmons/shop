import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { assertExistingTarotCredentialPin, assertTarotCredentialPin, assertTarotDeploymentActive, createTarotClaimLinks, loadTarotClaimLinks,
  provisionTarotCredentials, recordVerifiedTarotCredentials, TAROT_CREDENTIAL_PIN_PATH, tarotCredentialPin, tarotCredentialSql,
  tarotCredentials, verifyTarotCredentials } from '../scripts/tarot/claimLinks.ts';
import { runTarotOperations } from '../scripts/tarot/cli.ts';
import { rebindTarotCredentials } from '../scripts/tarot/rebind.ts';
import { verifyTarotMedia } from '../scripts/tarot/media.ts';
import { withMetadataLock } from '../scripts/ethereum-metadata/lock.ts';
import { encodeAbi } from '../shared/ethereum/abi.ts';
import { tarotCodeHashInput } from '../shared/ethereum/tarot.ts';

const contract = `0x${'12'.repeat(20)}`;
const replacementContract = `0x${'23'.repeat(20)}`;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const project = fileURLToPath(new URL('../onchain/ethereum/', import.meta.url));
let build: string;
let artifact: {
  bytecode: { object: string }; deployedBytecode: { object: string };
  metadata: { sources: Record<string, { keccak256: string }>; settings: Record<string, unknown> };
};

before(() => {
  build = mkdtempSync(join(tmpdir(), 'dmx-rebind-build-test-'));
  execFileSync('forge', ['build', '--offline', 'src/TarotCards.sol', '--out', join(build, 'out'),
    '--cache-path', join(build, 'cache')], { cwd: project, stdio: 'pipe', timeout: 30_000 });
  artifact = JSON.parse(readFileSync(join(build, 'out', 'TarotCards.sol', 'TarotCards.json'), 'utf8')) as typeof artifact;
});

after(() => { if (build) rmSync(build, { recursive: true, force: true }); });

test('private links are unique, resumable, scoped, and protected by filesystem permissions', t => {
  const root = mkdtempSync(join(tmpdir(), 'tarot-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.operations', 'tarot');
  const manifest = createTarotClaimLinks(directory, contract, root);
  assert.equal(manifest.links.length, 777);
  assert.equal(new Set(manifest.links.map(link => link.code)).size, 777);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'claim-links.private.json')).mode & 0o777, 0o600);
  assert.deepEqual(createTarotClaimLinks(directory, contract, root), manifest);
  assert.deepEqual(loadTarotClaimLinks(directory, root), manifest);
  const credentials = tarotCredentials(manifest);
  assert.equal(credentials[0].codeHash, createHash('sha256').update(tarotCodeHashInput({
    chainId: manifest.chainId, contractAddress: contract, tokenId: 1, code: manifest.links[0].code,
  })).digest('hex'));
  const sql = tarotCredentialSql(manifest);
  for (const link of manifest.links) {
    const url = new URL(link.url);
    assert.equal(url.origin, 'https://mons.shop');
    assert.equal(url.pathname, '/nfc');
    assert.equal(url.searchParams.get('tokenId'), String(link.tokenId));
    assert.equal(url.searchParams.get('testnet'), 'true');
    assert.equal(url.searchParams.get('code'), link.code);
    assert.ok(!sql.includes(link.code));
  }
  assert.throws(() => createTarotClaimLinks(directory, `0x${'23'.repeat(20)}`, root), /another deployment/);
  assert.throws(() => createTarotClaimLinks(join(root, 'public'), contract, root), /beneath .operations/);
  const shortcut = join(root, '.operations', 'shortcut');
  symlinkSync(directory, shortcut);
  assert.throws(() => createTarotClaimLinks(shortcut, contract, root), /0700/);
  const tampered = structuredClone(manifest);
  tampered.links[1] = { ...tampered.links[0], tokenId: 2 };
  assert.throws(() => tarotCredentials(tampered), /Invalid private/);
});

test('credential provisioning resumes, stores hashes only, and refuses mismatched or revoked rows', t => {
  const root = mkdtempSync(join(tmpdir(), 'tarot-db-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = createTarotClaimLinks(join(root, '.operations', 'tarot'), contract, root);
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('../cloud/workers/api/ops-migrations/0014_tarot_claim_codes.sql', import.meta.url), 'utf8'));
  const rows = () => database.prepare('SELECT * FROM tarot_claim_codes ORDER BY token_id').all();
  assert.throws(() => verifyTarotCredentials(manifest, rows(), true), /incomplete/);
  verifyTarotCredentials(manifest, rows(), false);
  database.exec(tarotCredentialSql(manifest));
  database.exec(tarotCredentialSql(manifest));
  verifyTarotCredentials(manifest, rows(), true);
  database.exec('UPDATE tarot_claim_codes SET code_hash=lower(hex(randomblob(32))) WHERE token_id=1');
  assert.throws(() => verifyTarotCredentials(manifest, rows(), false), /conflict/);
  assert.throws(() => database.exec(tarotCredentialSql(manifest)), /NOT NULL/);
  database.prepare('UPDATE tarot_claim_codes SET code_hash=? WHERE token_id=1').run(tarotCredentials(manifest)[0].codeHash);
  database.exec('UPDATE tarot_claim_codes SET revoked_at_ms=created_at_ms WHERE token_id=777');
  assert.throws(() => verifyTarotCredentials(manifest, rows(), true), /conflict/);
  assert.throws(() => database.exec(tarotCredentialSql(manifest)), /NOT NULL/);
});

test('credential pins require complete verification and cannot be replaced by another same-contract manifest', t => {
  const root = mkdtempSync(join(tmpdir(), 'tarot-credential-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = createTarotClaimLinks(join(root, '.operations', 'original'), contract, root);
  const alternate = createTarotClaimLinks(join(root, '.operations', 'alternate'), contract, root);
  const rowsFor = (value: typeof manifest) => tarotCredentials(value).map(row => ({
    chain_id: value.chainId, contract_address: value.contractAddress, token_id: row.tokenId,
    code_hash: row.codeHash, created_at_ms: value.createdAtMs, revoked_at_ms: null,
  }));
  const rows = rowsFor(manifest);
  const filename = join(root, TAROT_CREDENTIAL_PIN_PATH);
  assert.throws(() => recordVerifiedTarotCredentials(manifest, rows.slice(1), root), /incomplete/);
  assert.throws(() => recordVerifiedTarotCredentials(manifest, rowsFor(alternate), root), /conflict/);
  assert.throws(() => recordVerifiedTarotCredentials(manifest,
    rows.map((row, index) => index === 0 ? { ...row, revoked_at_ms: manifest.createdAtMs } : row), root), /conflict/);
  assert.equal(existsSync(filename), false);
  recordVerifiedTarotCredentials(manifest, rows, root);
  const original = readFileSync(filename, 'utf8');
  const pin = JSON.parse(original);
  assertTarotCredentialPin(manifest, pin);
  assert.equal(pin.credentialCount, 777);
  assert.equal(manifest.links.some(link => original.includes(link.code)), false);
  assert.equal(rows.some(row => original.includes(row.code_hash)), false);
  recordVerifiedTarotCredentials(manifest, rows, root);
  assert.equal(readFileSync(filename, 'utf8'), original);
  assert.throws(() => assertExistingTarotCredentialPin(alternate, root), /verified credential set/);
  assert.throws(() => recordVerifiedTarotCredentials(alternate, rowsFor(alternate), root), /verified credential set/);
  assert.equal(readFileSync(filename, 'utf8'), original);
  assert.deepEqual(tarotCredentialPin({ ...manifest, createdAtMs: manifest.createdAtMs + 1 }), tarotCredentialPin(manifest));
  assert.notEqual(tarotCredentialPin({ ...manifest, contractAddress: `0x${'23'.repeat(20)}` }).credentialSetSha256,
    pin.credentialSetSha256);
});

test('media verification checks all DMX cards, heroes, receipts, and layers without publishing metadata', async () => {
  const media: string[] = [];
  const result = await verifyTarotMedia(async (input, init) => {
    assert.equal(init?.method, 'HEAD');
    assert.equal(init?.redirect, 'error');
    media.push(String(input));
    return new Response(null, { headers: { 'content-type': 'image/webp', 'content-length': '100' } });
  });
  assert.deepEqual(result, { verified: true, artworkCount: 2341 });
  assert.equal(new Set(media).size, 2341);
  for (const [kind, count] of [['cards', 777], ['heroes', 777], ['receipts', 777], ['layers', 10]] as const) {
    const prefix = `https://wip.lil.org/dmx/${kind}/`;
    const ids = media.filter(url => url.startsWith(prefix)).map(url => Number(url.slice(prefix.length, -5)));
    assert.deepEqual(ids.sort((a, b) => a - b), Array.from({ length: count }, (_, index) => index + 1));
  }
  const invalidResponses: ResponseInit[] = [
    { status: 404 },
    { headers: { 'content-type': 'text/html', 'content-length': '100' } },
    { headers: { 'content-type': 'image/webp', 'content-length': '0' } },
    { headers: { 'content-type': 'image/webp' } },
  ];
  for (const response of invalidResponses) {
    await assert.rejects(() => verifyTarotMedia(async () => new Response(null, response)), /media unavailable/);
  }
});

function rebindFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dmx-rebind-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, '.operations', 'dmx-sepolia-v2');
  const directory = join(root, '.operations', 'dmx-sepolia-v3');
  const deploymentDirectory = join(root, '.operations', 'deployment');
  const sourcePin = join(root, 'releases', 'dmx-sepolia-v2', 'credential-set.json');
  const source = createTarotClaimLinks(sourceDirectory, contract, root);
  mkdirSync(dirname(sourcePin), { recursive: true });
  writeFileSync(sourcePin, json({ ...tarotCredentialPin(source), verifiedAt: new Date().toISOString() }));
  mkdirSync(deploymentDirectory, { mode: 0o700 });
  const settings = { ...artifact.metadata.settings };
  delete settings.compilationTarget;
  const input = { language: 'Solidity', settings,
    sources: Object.fromEntries(Object.keys(artifact.metadata.sources).map(name => [name, { content: readFileSync(join(project, name), 'utf8') }])) };
  const admin = '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93';
  const quoteSigner = '0x' + '34'.repeat(20);
  const renderer = '0x' + '45'.repeat(20);
  const constructorArgs = encodeAbi(['address', 'address', 'address'], [admin, quoteSigner, renderer]);
  const manifest = { releaseVersion: 2, network: 'sepolia', contractName: 'TarotCards', chainId: 11155111,
    contractAddress: replacementContract, admin, deployer: admin, quoteSigner, renderer, constructorArgs,
    creationCode: artifact.bytecode.object + constructorArgs.slice(2),
    artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(input)) };
  const deployment = { ...manifest, deploymentBlock: 100, deploymentBlockHash: '0x' + 'a'.repeat(64),
    transactionHash: '0x' + 'b'.repeat(64), confirmations: 3, verifiedAt: new Date().toISOString(),
    runtimeBytes: (artifact.deployedBytecode.object.length - 2) / 2,
    runtimeKeccak256: '0x' + Buffer.from(keccak_256(Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex'))).toString('hex'),
    initialCards: 777, maxCards: 999999, receiptOffset: 999999, redemptionReceiptOffset: 1000776,
    receipt: { status: '0x1', contractAddress: replacementContract, from: admin, to: null,
      transactionHash: '0x' + 'b'.repeat(64), blockHash: '0x' + 'a'.repeat(64), blockNumber: '0x64' } };
  const write = (name: string, value: unknown) => writeFileSync(join(deploymentDirectory, name), json(value));
  write('manifest.json', manifest);
  write('deployment.json', deployment);
  write('TarotCards.artifact.json', artifact);
  write('TarotCards.standard-input.json', input);
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (const name of ['0014_tarot_claim_codes.sql', '0017_dmx_sepolia_retirement.sql']) {
    database.exec(readFileSync(new URL('../cloud/workers/api/ops-migrations/' + name, import.meta.url), 'utf8'));
  }
  database.exec(tarotCredentialSql(source));
  const commands: string[] = [];
  const queries: string[] = [];
  const adapter = { query(sql: string) { queries.push(sql); return database.prepare(sql).all(); },
    executeCommand(sql: string) { commands.push(sql); database.exec(sql); } };
  const options = { root, sourceDirectory, sourcePin, deploymentDirectory, directory };
  return { ...options, options, source, manifest, deployment, input, database, adapter, commands, queries, write,
    target: () => loadTarotClaimLinks(directory, root),
    rows: (address: string) => database.prepare('SELECT * FROM tarot_claim_codes WHERE contract_address=? ORDER BY token_id').all(address),
    run: () => rebindTarotCredentials(options, adapter) };
}

test('rebind preserves every existing code, token and URL under the verified replacement and a new immutable pin', async t => {
  const f = rebindFixture(t);
  const oldManifest = readFileSync(join(f.sourceDirectory, 'claim-links.private.json'), 'utf8');
  const oldPin = readFileSync(f.sourcePin, 'utf8');
  const oldRows = f.rows(contract);
  const result = await f.run();
  const target = f.target();
  assert.equal(target.contractAddress, replacementContract);
  assert.ok(target.createdAtMs > f.source.createdAtMs);
  assert.deepEqual(target.links, f.source.links);
  assert.deepEqual(f.rows(contract), oldRows);
  verifyTarotCredentials(target, f.rows(replacementContract), true);
  assert.equal(readFileSync(join(f.sourceDirectory, 'claim-links.private.json'), 'utf8'), oldManifest);
  assert.equal(readFileSync(f.sourcePin, 'utf8'), oldPin);
  assert.equal(statSync(join(f.directory, 'claim-links.private.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'credential-rebind.private.json')).mode & 0o777, 0o600);
  const newPin = readFileSync(join(f.root, TAROT_CREDENTIAL_PIN_PATH), 'utf8');
  assertTarotCredentialPin(target, JSON.parse(newPin));
  assert.notEqual(JSON.parse(newPin).credentialSetSha256, JSON.parse(oldPin).credentialSetSha256);
  const output = JSON.stringify(result) + newPin + f.commands.join('\n') + f.queries.join('\n');
  for (const link of f.source.links) assert.ok(!output.includes(link.code) && !output.includes(link.url));
  const writes = f.commands.length;
  assert.deepEqual(await f.run(), result);
  assert.deepEqual(f.target(), target);
  assert.equal(f.commands.length, writes);
  assert.equal(readFileSync(join(f.root, TAROT_CREDENTIAL_PIN_PATH), 'utf8'), newPin);
  f.write('deployment.json', { ...f.deployment, confirmations: 100, verifiedAt: new Date().toISOString() });
  assert.deepEqual(await f.run(), result);
});

test('rebind resumes partial database writes and a journal-only local preparation without regenerating links', async t => {
  const f = rebindFixture(t);
  let attempts = 0;
  const interrupted = { ...f.adapter, executeCommand(sql: string) {
    if (++attempts === 3) throw new Error('Synthetic interruption');
    f.adapter.executeCommand(sql);
  } };
  await assert.rejects(rebindTarotCredentials(f.options, interrupted), /Synthetic interruption/);
  const target = f.target();
  const partial = f.rows(replacementContract);
  assert.equal(partial.length, 100);
  assert.equal(existsSync(join(f.root, TAROT_CREDENTIAL_PIN_PATH)), false);
  rmSync(join(f.directory, 'claim-links.private.json'));
  await f.run();
  assert.deepEqual(f.target(), target);
  assert.deepEqual(f.rows(replacementContract).slice(0, partial.length), partial);
  verifyTarotCredentials(target, f.rows(replacementContract), true);
});

test('rebind refuses missing or mismatched source pins, incomplete and revoked source rows before target writes', async t => {
  for (const change of ['missing-pin', 'wrong-pin', 'missing-row', 'revoked-row'] as const) {
    const f = rebindFixture(t);
    if (change === 'missing-pin') rmSync(f.sourcePin);
    if (change === 'wrong-pin') writeFileSync(f.sourcePin, json({ ...tarotCredentialPin(f.source), credentialSetSha256: 'f'.repeat(64) }));
    if (change === 'missing-row') f.database.exec('DELETE FROM tarot_claim_codes WHERE token_id=777');
    if (change === 'revoked-row') f.database.exec('UPDATE tarot_claim_codes SET revoked_at_ms=created_at_ms WHERE token_id=1');
    await assert.rejects(f.run());
    assert.equal(f.commands.length, 0);
    assert.equal(existsSync(join(f.directory, 'claim-links.private.json')), false);
    assert.equal(existsSync(join(f.root, TAROT_CREDENTIAL_PIN_PATH)), false);
  }
});

test('rebind refuses stale, unverified, legacy, or mismatched deployment evidence', async t => {
  for (const change of ['unverified', 'legacy', 'artifact', 'source', 'receipt', 'address'] as const) {
    const f = rebindFixture(t);
    if (change === 'unverified') f.write('deployment.json', { ...f.deployment, confirmations: 2 });
    if (change === 'legacy') f.write('manifest.json', { ...f.manifest, releaseVersion: 1 });
    if (change === 'artifact') f.write('TarotCards.artifact.json', { ...artifact, bytecode: { object: '0x00' } });
    if (change === 'source') f.write('TarotCards.standard-input.json', { ...f.input, sources: {} });
    if (change === 'receipt') f.write('deployment.json', { ...f.deployment, receipt: { ...f.deployment.receipt, status: '0x0' } });
    if (change === 'address') f.write('deployment.json', { ...f.deployment, contractAddress: contract });
    await assert.rejects(f.run());
    assert.equal(f.commands.length, 0);
    assert.equal(existsSync(join(f.directory, 'credential-rebind.private.json')), false);
  }
});

test('frozen rebind rejects changed source identity, replacement identity, local target and database rows', async t => {
  for (const change of ['source', 'source-pin', 'replacement', 'target', 'rows'] as const) {
    const f = rebindFixture(t);
    await f.run();
    const writes = f.commands.length;
    if (change === 'source') {
      writeFileSync(join(f.sourceDirectory, 'claim-links.private.json'), json({ ...f.source, createdAtMs: f.source.createdAtMs + 1 }));
      f.database.prepare('UPDATE tarot_claim_codes SET created_at_ms=created_at_ms+1 WHERE contract_address=?').run(contract);
    }
    if (change === 'source-pin') writeFileSync(f.sourcePin, json({ ...tarotCredentialPin(f.source), verifiedAt: '2020-01-01T00:00:00Z' }));
    if (change === 'replacement') {
      const changed = '0x' + '67'.repeat(20);
      f.write('manifest.json', { ...f.manifest, contractAddress: changed });
      f.write('deployment.json', { ...f.deployment, contractAddress: changed, receipt: { ...f.deployment.receipt, contractAddress: changed } });
    }
    if (change === 'target') writeFileSync(join(f.directory, 'claim-links.private.json'), json({ ...f.target(), createdAtMs: f.target().createdAtMs + 1 }));
    if (change === 'rows') f.database.prepare("UPDATE tarot_claim_codes SET code_hash=? WHERE contract_address=? AND token_id=1")
      .run('f'.repeat(64), replacementContract);
    await assert.rejects(f.run());
    assert.equal(f.commands.length, writes);
  }
});

test('retired deployments cannot be reprovisioned or selected as a rebind target', async t => {
  const f = rebindFixture(t);
  f.database.prepare('INSERT INTO dmx_retired_sepolia_deployments VALUES (11155111, ?, ?, ?)')
    .run(contract, replacementContract, Date.now());
  assert.throws(() => assertTarotDeploymentActive(f.source, f.adapter), /retired/);
  assert.throws(() => provisionTarotCredentials(f.source, f.adapter, f.root), /retired/);
  assert.throws(() => f.database.exec(tarotCredentialSql(f.source)), /Retired/);
  assert.equal(f.commands.length, 0);
  f.database.prepare('INSERT INTO dmx_retired_sepolia_deployments VALUES (11155111, ?, ?, ?)')
    .run(replacementContract, '0x' + '67'.repeat(20), Date.now());
  await assert.rejects(f.run(), /retired/);
  assert.equal(f.commands.length, 0);
  assert.equal(existsSync(join(f.directory, 'claim-links.private.json')), false);
});

test('rebind serializes source, target and deployment evidence without replacing a live lock', async t => {
  for (const scope of ['sourceDirectory', 'directory', 'deploymentDirectory'] as const) {
    const f = rebindFixture(t);
    mkdirSync(f.directory, { mode: 0o700 });
    const filename = join(f[scope], scope === 'deploymentDirectory' ? 'operation.lock' : 'claim-links.lock');
    await withMetadataLock(filename, async () => {
      await assert.rejects(f.run(), /Another metadata operation owns/);
      assert.equal(existsSync(filename), true);
      assert.equal(f.queries.length, 0);
      assert.equal(f.commands.length, 0);
      assert.equal(existsSync(join(f.directory, 'credential-rebind.private.json')), false);
    });
  }
});

test('rebind requires distinct directories and cannot adopt an unrelated preexisting target manifest', async t => {
  const f = rebindFixture(t);
  await assert.rejects(rebindTarotCredentials({ ...f.options, directory: f.sourceDirectory }, f.adapter), /distinct/);
  await assert.rejects(rebindTarotCredentials({ ...f.options, directory: join(f.sourceDirectory, 'nested') }, f.adapter), /distinct/);
  await assert.rejects(rebindTarotCredentials({ ...f.options, sourcePin: join(f.root, TAROT_CREDENTIAL_PIN_PATH) }, f.adapter), /distinct/);
  createTarotClaimLinks(f.directory, replacementContract, f.root);
  await assert.rejects(f.run(), /no frozen rebind evidence/);
  assert.equal(f.commands.length, 0);
});

test('the CLI rejects removed publisher commands and requires explicit rebind evidence before accessing credentials', async () => {
  for (const command of ['metadata', 'publish', 'verify-public']) await assert.rejects(runTarotOperations([command]), /Use verify-media/);
  for (const args of [['rebind'], ['rebind', '--source-directory', 'unused'],
    ['rebind', '--source-directory', 'unused', '--source-pin', 'unused']]) {
    await assert.rejects(runTarotOperations(args), /rebind requires/);
  }
  await assert.rejects(runTarotOperations(['links', '--source-pin', 'unused']), /only allowed for rebind/);
  await assert.rejects(runTarotOperations(['verify-media', '--directory', 'unused']), /does not accept/);
  assert.equal(TAROT_CREDENTIAL_PIN_PATH, 'releases/dmx-sepolia-v3/credential-set.json');
});
