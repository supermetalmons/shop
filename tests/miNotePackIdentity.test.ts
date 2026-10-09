import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { fetchMiNotePackId } from '../src/lib/miNotePackIdentity.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';

const asset = new PublicKey(new Uint8Array(32).fill(7));

function string(value: string): Buffer {
  const bytes = Buffer.from(value);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}

function account(dropId: string, uri?: string): AccountInfo<Buffer> {
  const drop = getFrontendDrop(dropId)!;
  return {
    owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), executable: false, lamports: 1,
    data: Buffer.concat([
      Buffer.from([1]), Buffer.alloc(32, 9), Buffer.from([2]), new PublicKey(drop.collectionMint).toBuffer(),
      string('Pack 9'), string(uri ?? `${drop.paths.boxesJsonBase}9.json`), Buffer.from([0]),
    ]),
  };
}

for (const dropId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${dropId} reads a vault-owned pack ID directly from its Core account`, async () => {
    const id = await fetchMiNotePackId({ getAccountInfo: async (address, commitment) => {
      assert.equal(address.toBase58(), asset.toBase58());
      assert.equal(commitment, 'confirmed');
      return account(dropId);
    } }, getFrontendDrop(dropId)!, asset.toBase58());
    assert.equal(id, '9');
  });
}

test('pack identity rejects missing, unrelated, truncated, and noncanonical accounts', async () => {
  const drop = getFrontendDrop('mi_note_cards')!;
  const wrongKey = account(drop.dropId);
  wrongKey.data[0] = 0;
  const wrongAuthority = account(drop.dropId);
  wrongAuthority.data[33] = 1;
  const oversizedName = account(drop.dropId);
  oversizedName.data.writeUInt32LE(5000, 66);
  for (const record of [
    null, wrongKey, wrongAuthority, oversizedName,
    { ...account(drop.dropId), owner: asset },
    account('mi_note_cards_devnet'),
    { ...account(drop.dropId), data: Buffer.alloc(20) },
    { ...account(drop.dropId), data: account(drop.dropId).data.subarray(0, 74) },
    ...['0.json', '09.json', `${drop.maxSupply + 1}.json`, '9.json?x=1'].map(suffix => account(drop.dropId, `${drop.paths.boxesJsonBase}${suffix}`)),
    account(drop.dropId, `${drop.paths.figuresJsonBase}9.json`),
  ]) {
    assert.equal(await fetchMiNotePackId({ getAccountInfo: async () => record }, drop, asset.toBase58()), undefined);
  }
});
