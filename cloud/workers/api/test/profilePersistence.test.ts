import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { D1ProfileAddress } from '../../../../shared/profileD1.ts';
import { loadD1ProfileAddress, saveD1ProfileAddress } from '../src/profileD1.ts';
import { loadEthereumProfile, loadEthereumProfileAddress, saveEthereumProfileAddress } from '../src/ethereumProfileStore.ts';
import { ProfileAddressConflictError } from '../src/profilePersistence.ts';
import { d1Database } from './commerceD1Harness.ts';

const ADDRESS_ID = 'ABCDEFGHIJKLMNOPQRST';
const ADDRESS: Omit<D1ProfileAddress, 'wallet'> = {
  id: ADDRESS_ID,
  encrypted: 'encrypted-address',
  country: 'United States',
  countryCode: 'US',
  hint: 'US',
  email: 'owner@example.com',
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};
const ETHEREUM_WALLET = `0x${'11'.repeat(20)}`;
const adapters = [
  { chain: 'solana', wallet: '11111111111111111111111111111111', profileTable: 'profiles',
    addressTable: 'profile_addresses', save: saveD1ProfileAddress, load: loadD1ProfileAddress },
  { chain: 'ethereum', wallet: ETHEREUM_WALLET, profileTable: 'ethereum_profiles',
    addressTable: 'ethereum_profile_addresses', save: saveEthereumProfileAddress, load: loadEthereumProfileAddress },
] as const;

function fixture(t: TestContext, applyGuards = true) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync('cloud/workers/api/ops-migrations/0001_current_schema.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql', 'utf8'));
  const migrate = () => database.exec(readFileSync('cloud/workers/api/ops-migrations/0010_ethereum_profile_address_guards.sql', 'utf8'));
  if (applyGuards) migrate();
  return { database, db: d1Database(database), migrate };
}

for (const adapter of adapters) {
  test(`${adapter.chain} address retries are idempotent and conflicts roll back profile changes`, async (t) => {
    const { database, db } = fixture(t);
    const address = { ...ADDRESS, wallet: adapter.wallet };
    const original = await adapter.save(db, address);
    assert.deepEqual(await adapter.save(db, { ...address, createdAtMs: 2_000, updatedAtMs: 2_000 }), original);
    const before = database.prepare(`SELECT * FROM ${adapter.profileTable}`).get();
    await assert.rejects(adapter.save(db, { ...address, email: 'replacement@example.com',
      hint: 'changed', createdAtMs: 3_000, updatedAtMs: 3_000 }), ProfileAddressConflictError);
    assert.deepEqual(database.prepare(`SELECT * FROM ${adapter.profileTable}`).get(), before);
    assert.equal(database.prepare(`SELECT created_at_ms FROM ${adapter.addressTable}`).get()?.created_at_ms, 1_000);
    assert.equal((await adapter.load(db, adapter.wallet, ADDRESS_ID))?.hint, ADDRESS.hint);
  });

  test(`${adapter.chain} older email writes and address-only writes preserve newer profile email`, async (t) => {
    const { database, db } = fixture(t);
    await adapter.save(db, { ...ADDRESS, wallet: adapter.wallet, createdAtMs: 3_000, updatedAtMs: 3_000 });
    await adapter.save(db, { ...ADDRESS, wallet: adapter.wallet, id: 'B'.repeat(20), email: 'older@example.com' });
    const { email: _, ...withoutEmail } = ADDRESS;
    await adapter.save(db, { ...withoutEmail, wallet: adapter.wallet, id: 'C'.repeat(20), createdAtMs: 4_000, updatedAtMs: 4_000 });
    assert.deepEqual({ ...database.prepare(`SELECT * FROM ${adapter.profileTable}`).get() }, {
      wallet: adapter.wallet, email: ADDRESS.email, created_at_ms: 1_000, updated_at_ms: 3_000,
    });
  });

  test(`${adapter.chain} concurrent conflicting saves keep only the winning address and email`, async (t) => {
    const { database, db } = fixture(t);
    const first = { ...ADDRESS, wallet: adapter.wallet };
    const results = await Promise.allSettled([
      adapter.save(db, first),
      adapter.save(db, { ...first, email: 'loser@example.com', hint: 'loser', updatedAtMs: 2_000 }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof ProfileAddressConflictError).length, 1);
    const saved = await adapter.load(db, adapter.wallet, ADDRESS_ID);
    assert.equal(database.prepare(`SELECT email FROM ${adapter.profileTable}`).get()?.email, saved?.email);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${adapter.addressTable}`).get()?.count, 1);
  });

  test(`${adapter.chain} a lost commit acknowledgement retries the same address safely`, async (t) => {
    const { database } = fixture(t);
    let commits = 0;
    const db = d1Database(database, undefined, () => {
      commits += 1;
      if (commits === 1) throw new Error('D1_ERROR: Network connection lost');
    });
    const result = await adapter.save(db, { ...ADDRESS, wallet: adapter.wallet });
    assert.equal(result.id, ADDRESS_ID);
    assert.equal(commits, 2);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${adapter.addressTable}`).get()?.count, 1);
  });
}

test('Ethereum migration preserves existing JSON and ignores its key order during retries', async (t) => {
  const { database, db, migrate } = fixture(t, false);
  const json = JSON.stringify({ hint: ADDRESS.hint, country: ADDRESS.country, id: ADDRESS_ID,
    email: ADDRESS.email, countryCode: ADDRESS.countryCode, encrypted: ADDRESS.encrypted });
  database.prepare('INSERT INTO ethereum_profiles VALUES (?, ?, 1000, 1000)').run(ETHEREUM_WALLET, ADDRESS.email!);
  database.prepare('INSERT INTO ethereum_profile_addresses VALUES (?, ?, ?, 1000)').run(ETHEREUM_WALLET, ADDRESS_ID, json);
  migrate();
  const saved = await saveEthereumProfileAddress(db, { ...ADDRESS, wallet: ETHEREUM_WALLET });
  assert.equal(database.prepare('SELECT address_json FROM ethereum_profile_addresses').get()?.address_json, json);
  assert.deepEqual(await loadEthereumProfile(db, ETHEREUM_WALLET), {
    wallet: ETHEREUM_WALLET, email: ADDRESS.email, addresses: [saved],
  });
  assert.throws(() => database.exec('DELETE FROM ethereum_profile_addresses'), /immutable/);
  assert.throws(() => database.exec("UPDATE ethereum_profile_addresses SET address_json = '{}'"), /immutable/);
});

test('Ethereum address reads validate stored fields and identity', async (t) => {
  const { database, db } = fixture(t);
  database.prepare('INSERT INTO ethereum_profiles VALUES (?, NULL, 1000, 1000)').run(ETHEREUM_WALLET);
  database.prepare('INSERT INTO ethereum_profile_addresses VALUES (?, ?, ?, 1000)')
    .run(ETHEREUM_WALLET, ADDRESS_ID, JSON.stringify({ ...ADDRESS, id: 'B'.repeat(20) }));
  await assert.rejects(loadEthereumProfileAddress(db, ETHEREUM_WALLET, ADDRESS_ID), /identity is invalid/);
  await assert.rejects(loadEthereumProfile(db, ETHEREUM_WALLET), /identity is invalid/);
  database.prepare('INSERT INTO ethereum_profile_addresses VALUES (?, ?, ?, 1000)')
    .run(ETHEREUM_WALLET, 'C'.repeat(20), JSON.stringify({ ...ADDRESS, id: 'C'.repeat(20), encrypted: 42 }));
  await assert.rejects(loadEthereumProfileAddress(db, ETHEREUM_WALLET, 'C'.repeat(20)), /ciphertext is invalid/);
});
