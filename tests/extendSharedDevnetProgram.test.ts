import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  assertExtensionResult,
  assertProgramSnapshotUnchanged,
  buildExtendProgramArgs,
  extensionBytesForCapacity,
  SHARED_DEVNET_TARGET_CAPACITY,
  type ProgramSnapshot,
} from '../scripts/extend-shared-devnet-program.ts';

const HEADER_BYTES = 45;
const AUTHORITY = new PublicKey(
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
);

function snapshot(args: {
  capacity: number;
  slot: bigint;
  fill?: number;
  authority?: PublicKey;
}): ProgramSnapshot {
  const programData = Buffer.alloc(HEADER_BYTES + args.capacity);
  programData.fill(args.fill ?? 0x5a, HEADER_BYTES);
  return {
    authority: args.authority ?? AUTHORITY,
    contextSlot: Number(args.slot + 1n),
    programData,
    programDataLamports: 1,
    slot: args.slot,
  };
}

function extendedSnapshots(): {
  before: ProgramSnapshot;
  after: ProgramSnapshot;
} {
  const before = snapshot({ capacity: 482_520, slot: 100n });
  const after = snapshot({
    capacity: SHARED_DEVNET_TARGET_CAPACITY,
    slot: 101n,
    fill: 0,
  });
  before.programData.copy(after.programData, 0, 0, before.programData.length);
  after.programData.writeBigUInt64LE(after.slot, 4);
  return { before, after };
}

test('shared devnet extension targets mainnet-equivalent capacity', () => {
  assert.equal(extensionBytesForCapacity(482_520), 36_200);
  assert.equal(
    extensionBytesForCapacity(SHARED_DEVNET_TARGET_CAPACITY),
    0,
  );
  assert.throws(() => extensionBytesForCapacity(0), /Invalid current/);
  assert.throws(
    () => extensionBytesForCapacity(SHARED_DEVNET_TARGET_CAPACITY + 1),
    /already exceeds/,
  );
});

test('extend command retains preflight and finalized confirmation', () => {
  const args = buildExtendProgramArgs({
    additionalBytes: 36_200,
    rpcUrl: 'https://api.devnet.solana.com',
    signerPath: '/private/authority.pipe',
  });
  assert.deepEqual(args, [
    'program',
    'extend',
    '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    '36200',
    '--url',
    'https://api.devnet.solana.com',
    '--keypair',
    '/private/authority.pipe',
    '--commitment',
    'finalized',
    '--output',
    'json',
  ]);
  assert.equal(args.includes('--skip-preflight'), false);
});

test('extension verification requires unchanged code and zero-filled growth', () => {
  const valid = extendedSnapshots();
  assert.doesNotThrow(() => assertExtensionResult(valid));

  const changedCode = extendedSnapshots();
  changedCode.after.programData[HEADER_BYTES + 1] ^= 0xff;
  assert.throws(
    () => assertExtensionResult(changedCode),
    /payload changed/,
  );

  const nonzeroGrowth = extendedSnapshots();
  nonzeroGrowth.after.programData[
    HEADER_BYTES + nonzeroGrowth.before.programData.length - HEADER_BYTES
  ] = 1;
  assert.throws(
    () => assertExtensionResult(nonzeroGrowth),
    /unexpected nonzero bytes/,
  );
});

test('extension verification rejects identity and capacity drift', () => {
  const staleSlot = extendedSnapshots();
  staleSlot.after.slot = staleSlot.before.slot;
  assert.throws(
    () => assertExtensionResult(staleSlot),
    /slot did not advance/,
  );

  const changedAuthority = extendedSnapshots();
  changedAuthority.after.authority = PublicKey.default;
  assert.throws(
    () => assertExtensionResult(changedAuthority),
    /authority changed/,
  );

  const wrongCapacity = extendedSnapshots();
  wrongCapacity.after.programData = wrongCapacity.after.programData.subarray(
    0,
    -1,
  );
  assert.throws(
    () => assertExtensionResult(wrongCapacity),
    /Final ProgramData capacity/,
  );

  const staleContext = extendedSnapshots();
  staleContext.after.contextSlot = Number(staleContext.after.slot - 1n);
  assert.throws(
    () => assertExtensionResult(staleContext),
    /snapshot predates/,
  );

  const insufficientRent = extendedSnapshots();
  assert.throws(
    () =>
      assertExtensionResult({
        ...insufficientRent,
        minimumLamports: 2,
      }),
    /not rent exempt/,
  );
});

test('pre-send snapshot guard rejects every material state change', () => {
  const baseline = snapshot({ capacity: 482_520, slot: 100n });
  assert.doesNotThrow(() =>
    assertProgramSnapshotUnchanged({ before: baseline, after: baseline }),
  );

  const changedBalance = {
    ...baseline,
    programDataLamports: baseline.programDataLamports + 1,
  };
  assert.throws(
    () =>
      assertProgramSnapshotUnchanged({
        before: baseline,
        after: changedBalance,
      }),
    /balance changed/,
  );

  const changedPayload = {
    ...baseline,
    programData: Buffer.from(baseline.programData),
  };
  changedPayload.programData[HEADER_BYTES] ^= 0xff;
  assert.throws(
    () =>
      assertProgramSnapshotUnchanged({
        before: baseline,
        after: changedPayload,
      }),
    /account changed/,
  );
});
