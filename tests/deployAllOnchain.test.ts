import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  assertMplCoreCollectionHasUpdateDelegates,
  decodeMplCoreCollectionUpdateDelegates,
  formatFreshProgramKeypairNotice,
} from '../scripts/deploy-all-onchain.ts';

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function pubkey(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff));
}

function encodePluginAuthority(kind: number, address?: PublicKey): Buffer {
  return kind === 3 ? Buffer.concat([u8(kind), (address || pubkey(240)).toBuffer()]) : u8(kind);
}

function encodeCollectionWithUpdateDelegates(args: {
  delegates?: PublicKey[];
  includeUpdateDelegatePlugin?: boolean;
  pluginAuthorityKind?: number;
  pluginAuthorityAddress?: PublicKey;
}): Buffer {
  const base = Buffer.concat([
    u8(5), // CollectionV1
    pubkey(1).toBuffer(), // update authority
    borshString('Test Collection'),
    borshString('https://assets.example.com/collection.json'),
    u32LE(0), // numMinted
    u32LE(0), // currentSize
  ]);

  if (args.includeUpdateDelegatePlugin === false) {
    return base;
  }

  const delegates = args.delegates || [];
  const pluginData = Buffer.concat([u8(4), u32LE(delegates.length), ...delegates.map((delegate) => delegate.toBuffer())]);
  const pluginOffset = base.length + 9;
  const registryOffset = pluginOffset + pluginData.length;
  const registryRecord = Buffer.concat([
    u8(4), // UpdateDelegate plugin type
    encodePluginAuthority(args.pluginAuthorityKind ?? 2, args.pluginAuthorityAddress),
    u64LE(pluginOffset),
  ]);
  const pluginHeader = Buffer.concat([u8(3), u64LE(registryOffset)]);
  const registry = Buffer.concat([u8(4), u32LE(1), registryRecord]);

  return Buffer.concat([base, pluginHeader, pluginData, registry]);
}

test('decodeMplCoreCollectionUpdateDelegates decodes UpdateDelegate entries', () => {
  const configPda = pubkey(10);
  const admin = pubkey(30);
  const data = encodeCollectionWithUpdateDelegates({ delegates: [configPda, admin] });

  const decoded = decodeMplCoreCollectionUpdateDelegates(data);

  assert.ok(decoded);
  assert.equal(decoded.authorityKind, 2);
  assert.deepEqual(
    decoded.delegates.map((delegate) => delegate.toBase58()),
    [configPda.toBase58(), admin.toBase58()],
  );
});

test('assertMplCoreCollectionHasUpdateDelegates rejects missing delegates', () => {
  const configPda = pubkey(10);
  const admin = pubkey(30);
  const data = encodeCollectionWithUpdateDelegates({ delegates: [admin] });

  assert.throws(
    () =>
      assertMplCoreCollectionHasUpdateDelegates({
        data,
        collection: pubkey(50),
        requiredDelegates: [configPda, admin],
      }),
    /Core collection UpdateDelegate missing required delegate/,
  );
});

test('assertMplCoreCollectionHasUpdateDelegates rejects missing UpdateDelegate plugin', () => {
  assert.throws(
    () =>
      assertMplCoreCollectionHasUpdateDelegates({
        data: encodeCollectionWithUpdateDelegates({ includeUpdateDelegatePlugin: false }),
        collection: pubkey(50),
        requiredDelegates: [pubkey(10), pubkey(30)],
      }),
    /Missing\/undecodable UpdateDelegate plugin/,
  );
});

test('assertMplCoreCollectionHasUpdateDelegates rejects externally controlled UpdateDelegate plugin', () => {
  const configPda = pubkey(10);
  const admin = pubkey(30);
  const externalAuthority = pubkey(80);
  const data = encodeCollectionWithUpdateDelegates({
    delegates: [configPda, admin],
    pluginAuthorityKind: 3,
    pluginAuthorityAddress: externalAuthority,
  });

  assert.throws(
    () =>
      assertMplCoreCollectionHasUpdateDelegates({
        data,
        collection: pubkey(50),
        requiredDelegates: [configPda, admin],
      }),
    /UpdateDelegate plugin authority mismatch/,
  );
});

test('formatFreshProgramKeypairNotice warns to back up non-git fresh shared program keypair', () => {
  const notice = formatFreshProgramKeypairNotice({
    programId: 'Program1111111111111111111111111111111111111',
    programKeypairPath: 'onchain/target/deploy/box_minter-keypair.json',
    backupPath: 'onchain/target/deploy/box_minter-keypair.bak.json',
  });

  assert.match(notice, /FRESH SHARED PROGRAM KEYPAIR CREATED/);
  assert.match(notice, /Program1111111111111111111111111111111111111/);
  assert.match(notice, /Keypair path: .*onchain\/target\/deploy\/box_minter-keypair\.json/);
  assert.match(notice, /Back up this keypair file immediately/);
  assert.match(notice, /not tracked by git/);
  assert.match(notice, /Previous keypair backup: .*onchain\/target\/deploy\/box_minter-keypair\.bak\.json/);
});
