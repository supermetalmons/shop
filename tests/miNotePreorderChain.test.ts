import assert from 'node:assert/strict';
import bs58 from 'bs58';
import test, { type TestContext } from 'node:test';
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { DEPLOYMENT_DROPS } from '../shared/deploymentRegistry.ts';
import { getPreorderConfig } from '../shared/preorders.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';
import { MI_NOTE_CLUSTER_GENESIS, readMiNotePreorderChain, verifyMiNoteDropManifest, prepareMiNoteDropManifest } from '../scripts/shared/miNoteDropManifest.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';
import { miNoteManifestFixture } from './helpers/miNoteManifest.ts';

function u32(value: number) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function string(value: string) { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); }

function chainFixture(t: TestContext) {
  const config = getPreorderConfig('mi_note_cards_devnet')!;
  const expected = Array.from({ length: 22 }, (_, index) => ({ id: index + 1,
    address: new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58() }));
  const account = (data: Buffer): AccountInfo<Buffer> => ({ data, executable: false,
    owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), lamports: 1, rentEpoch: 0 });
  const asset = (id: number, uri = `${config.metadataBase}${id}.json`) => account(Buffer.concat([
    Buffer.from([1]), new Uint8Array(32).fill(9), Buffer.from([2]), bs58.decode(config.collection),
    string(`Preorder #${id}`), string(uri), Buffer.from([0]),
  ]));
  const accounts = new Map(expected.map(({ id, address }) => [address, asset(id)]));
  const state = { slot: 10, size: 22, minted: 22, directReads: [] as string[][], scanned: expected.slice(0, 18).map((entry) => entry.address) };
  const collection = () => account(Buffer.concat([Buffer.from([5]), bs58.decode(config.authority),
    string('Mi Note Cards'), string(`${config.metadataBase}collection.json`), u32(state.minted), u32(state.size)]));
  const connection = new Connection('https://fixture.example.com');
  t.mock.method(connection, 'getGenesisHash', async () => MI_NOTE_CLUSTER_GENESIS.devnet);
  t.mock.method(connection, 'getProgramAccounts', async () => ({ context: { slot: ++state.slot },
    value: state.scanned.map((address) => ({ pubkey: new PublicKey(address), account: accounts.get(address)! })) }));
  t.mock.method(connection, 'getMultipleAccountsInfoAndContext', async (keys: PublicKey[]) => {
    state.directReads.push(keys.map((key) => key.toBase58()));
    return { context: { slot: ++state.slot }, value: keys.map((key) => key.toBase58() === config.collection
      ? collection() : accounts.get(key.toBase58()) ?? null) };
  });
  return { config, expected, state, accounts, connection, asset };
}

test('prelaunch coverage directly verifies all22 claimed assets even when the collection index returns18', async (t) => {
  const fixture = chainFixture(t);
  const result = await readMiNotePreorderChain(fixture.config, fixture.expected, fixture.connection);
  assert.equal(result.assets.length, 22);
  assert.ok(fixture.expected.every(({ address }) => fixture.state.directReads.flat().includes(address)));
  fixture.state.size = 23;
  await assert.rejects(readMiNotePreorderChain(fixture.config, fixture.expected, fixture.connection), /coverage is incomplete/);
});

test('registered frozen verification permits compressed members but still checks every recorded preorder', async (t) => {
  const fixture = chainFixture(t);
  fixture.state.size = 25;
  fixture.state.minted = 25;
  const result = await readMiNotePreorderChain(fixture.config, fixture.expected, fixture.connection, { requireCompleteMembership: false });
  assert.equal(result.assets.length, 22);
  const last = fixture.expected.at(-1)!;
  fixture.accounts.delete(last.address);
  await assert.rejects(readMiNotePreorderChain(fixture.config, fixture.expected, fixture.connection,
    { requireCompleteMembership: false }), /missing or is not a valid Core asset/);
  fixture.accounts.set(last.address, fixture.asset(1));
  await assert.rejects(readMiNotePreorderChain(fixture.config, fixture.expected, fixture.connection,
    { requireCompleteMembership: false }), /identities differ/);
});

test('frozen verification still rejects observed unknown preorder identities', async (t) => {
  const fixture = chainFixture(t);
  const address = new PublicKey(new Uint8Array(32).fill(90)).toBase58();
  fixture.accounts.set(address, fixture.asset(100));
  fixture.state.scanned.push(address);
  fixture.state.size = 23;
  await assert.rejects(readMiNotePreorderChain(fixture.config, fixture.expected, fixture.connection,
    { requireCompleteMembership: false }), /unaccounted preorder identity/);
});

test('new preparation is always strict while existing verification changes mode only after exact public registration', async (t) => {
  const fixture = miNoteManifestFixture();
  const manifest = await fixture.manifest();
  const dropId = manifest.sourcePreorder.preorderId;
  const previous = DEPLOYMENT_DROPS[dropId];
  t.after(() => { if (previous) DEPLOYMENT_DROPS[dropId] = previous; else delete DEPLOYMENT_DROPS[dropId]; });
  delete DEPLOYMENT_DROPS[dropId];
  const modes: boolean[] = [];
  const dependencies = { ...fixture.dependencies, chain: async (_config: unknown, _assets: unknown,
    options: { requireCompleteMembership: boolean }) => { modes.push(options.requireCompleteMembership); return fixture.chain; } };
  await verifyMiNoteDropManifest(manifest, dependencies);
  DEPLOYMENT_DROPS[dropId] = { ...miNoteDropFixture(), maxSupply: manifest.packCount,
    inventoryManifest: { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds } };
  await verifyMiNoteDropManifest(manifest, dependencies);
  await prepareMiNoteDropManifest(dropId, dependencies);
  assert.deepEqual(modes, [true, false, true]);
  fixture.snapshot.orders[0].revision += 1;
  await assert.rejects(verifyMiNoteDropManifest(manifest, dependencies), /stale/);
});
