import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assertExistingTarotCredentialPin, assertTarotCredentialPin, createTarotClaimLinks, loadTarotClaimLinks,
  recordVerifiedTarotCredentials, TAROT_CREDENTIAL_PIN_PATH, tarotCredentialPin, tarotCredentialSql,
  tarotCredentials, verifyTarotCredentials } from '../scripts/tarot/claimLinks.ts';
import { publishTarotMetadata, TAROT_METADATA_PREFIX, tarotMetadataObjects, verifyPublicTarotMetadata, verifyTarotMedia } from '../scripts/tarot/catalog.ts';
import { tarotCodeHashInput } from '../shared/ethereum/tarot.ts';
import type { MetadataStorage } from '../scripts/ethereum-metadata/storage.ts';

const contract = `0x${'12'.repeat(20)}`;

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

test('every Tarot card and receipt metadata record maps to its exact public artwork', () => {
  const objects = tarotMetadataObjects();
  assert.equal(objects.size, 1555);
  for (let tokenId = 1; tokenId <= 1554; tokenId++) {
    const metadata = JSON.parse(objects.get(`${tokenId}.json`)!.toString());
    const receipt = tokenId > 777;
    const cardId = receipt ? tokenId - 777 : tokenId;
    assert.equal(metadata.image, `https://wip.lil.org/tarot/${receipt ? 'receipts' : 'bases'}/${cardId}.webp`);
    assert.equal(metadata.attributes[1].value, cardId);
    assert.ok(!JSON.stringify(metadata).includes('code='));
  }
});

test('metadata publication is idempotent, reads every object back, and never overwrites conflicting objects', async () => {
  const remote = new Map<string, Buffer>();
  let writes = 0;
  const storage: MetadataStorage = {
    destination: { bucket: 'cdn-mons-shop', endpoint: 'https://example.test' },
    async *list(prefix) {
      for (const [key, value] of remote) {
        assert.ok(key.startsWith(prefix));
        yield { key, bytes: value.length, md5: createHash('md5').update(value).digest('hex') };
      }
    },
    async get(key) { return remote.get(key)!; },
    async put(key, body, expected) {
      assert.equal(expected, null);
      assert.equal(remote.has(key), false);
      remote.set(key, body);
      writes++;
    },
    close() {},
  };
  assert.equal((await publishTarotMetadata(storage)).uploaded, 1555);
  assert.equal((await publishTarotMetadata(storage)).uploaded, 0);
  assert.equal(writes, 1555);
  remote.set(TAROT_METADATA_PREFIX + '777.json', Buffer.from('{}'));
  await assert.rejects(() => publishTarotMetadata(storage), /conflicts/);
  assert.equal(writes, 1555);
});

test('public verification checks all media and exact metadata bytes', async () => {
  let media = 0;
  await verifyTarotMedia(async (_input, init) => {
    assert.equal(init?.method, 'HEAD');
    media++;
    return new Response(null, { headers: { 'content-type': 'image/webp', 'content-length': '100' } });
  });
  assert.equal(media, 1554);
  await assert.rejects(() => verifyTarotMedia(async () => new Response(null, { status: 404 })), /media unavailable/);
  const objects = tarotMetadataObjects();
  let records = 0;
  await verifyPublicTarotMetadata(async input => {
    records++;
    const name = new URL(String(input)).pathname.split('/').at(-1)!;
    return new Response(new Uint8Array(objects.get(name)!), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal(records, 1555);
  await assert.rejects(() => verifyPublicTarotMetadata(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })), /mismatch/);
});
