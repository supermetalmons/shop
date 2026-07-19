import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../functions/src/shared/solanaProgramAddresses.ts';

test('canonical Solana program addresses are valid public keys', () => {
  for (const address of [
    MPL_CORE_PROGRAM_ADDRESS,
    MPL_NOOP_PROGRAM_ADDRESS,
    SPL_NOOP_PROGRAM_ADDRESS,
    MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
    BUBBLEGUM_PROGRAM_ADDRESS,
    MPL_CORE_CPI_SIGNER_ADDRESS,
  ]) {
    assert.equal(new PublicKey(address).toBase58(), address);
  }
});

test('SPL and Metaplex Noop addresses remain distinct canonical programs', () => {
  assert.equal(
    SPL_NOOP_PROGRAM_ADDRESS,
    'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
  );
  assert.equal(
    MPL_NOOP_PROGRAM_ADDRESS,
    'mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3',
  );
  assert.notEqual(SPL_NOOP_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS);
});
