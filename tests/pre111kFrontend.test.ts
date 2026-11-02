import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePre111kReservation, resolvePre111kConfig, type Pre111kNetwork, type Pre111kPrepareResponse, type Pre111kStatus } from '../shared/ethereum/pre111k.ts';
import { checkedPre111kReservation, pre111kApi } from '../src/ethereum/pre111kApi.ts';

const wallet = '0x1111111111111111111111111111111111111111';
const contract = '0x3333333333333333333333333333333333333333';
const hash = `0x${'aa'.repeat(32)}`;
function status(network: Pre111kNetwork): Pre111kStatus {
  return { config: resolvePre111kConfig(network, { contractAddress: contract, enabled: true }), wallet,
    totalReserved: 7, reservedRelics: 2, remainingRelics: 11, observedBlock: 100, blockHash: hash };
}
function prepared(network: Pre111kNetwork): Pre111kPrepareResponse {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const signature = `0x${'11'.repeat(65)}`;
  const config = status(network).config;
  return { network, wallet, nonce: 2, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { to: contract, chainId: config.chainId, value: `0x${BigInt(config.priceWei).toString(16)}`, data: encodePre111kReservation(2, deadline, signature) } };
}

test('relic status accepts each network with its exact price and validates wallet counts', async t => {
  let response: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  for (const network of ['mainnet', 'devnet'] as const) {
    response = status(network);
    assert.deepEqual(await pre111kApi.status(network, wallet), response);
    for (const invalid of [
      { ...status(network), wallet: contract },
      { ...status(network), reservedRelics: 8 },
      { ...status(network), totalReserved: 19 },
      { ...status(network), remainingRelics: 12 },
      { ...status(network), observedBlock: null },
      { ...status(network), config: { ...status(network).config, chainId: 31337 } },
      { ...status(network), config: { ...status(network).config, priceWei: '23000000000000000' } },
      { ...status(network), config: { ...status(network).config, treasury: contract } },
      { ...status(network), config: { ...status(network).config, walletRpcUrl: 'http://evil.example' } },
    ]) {
      response = invalid;
      await assert.rejects(pre111kApi.status(network, wallet));
    }
  }
});

test('undeployed mainnet reports unknown counts instead of fabricated zero reservations', async t => {
  const value = { config: resolvePre111kConfig('mainnet'), wallet, totalReserved: null, reservedRelics: null, remainingRelics: null, observedBlock: null, blockHash: null };
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  assert.deepEqual(await pre111kApi.status('mainnet', wallet), value);
});

test('reservation checks bind wallet, nonce, exact price, network and calldata before sending', () => {
  for (const network of ['mainnet', 'devnet'] as const) {
    const value = prepared(network);
    const config = status(network).config;
    assert.deepEqual(checkedPre111kReservation(value, config, wallet, 2), value.transaction);
    for (const invalid of [
      { ...value, network: network === 'mainnet' ? 'devnet' : 'mainnet' },
      { ...value, wallet: contract },
      { ...value, nonce: 3 },
      { ...value, deadline: 1 },
      { ...value, expiresAtMs: 1 },
      { ...value, signature: '0x' },
      { ...value, transaction: { ...value.transaction, to: wallet } },
      { ...value, transaction: { ...value.transaction, chainId: 31337 } },
      { ...value, transaction: { ...value.transaction, value: '0x0' } },
      { ...value, transaction: { ...value.transaction, data: '0x' } },
      { ...value, transaction: { ...value.transaction, data: encodePre111kReservation(3, value.deadline, value.signature) } },
    ]) assert.throws(() => checkedPre111kReservation(invalid as Pre111kPrepareResponse, config, wallet, 2));
  }
});

test('confirmation validates transaction identity, finality and reservation nonce', async t => {
  let response: unknown = { status: 'pending', confirmations: 1, transactionHash: hash, reservationNonce: null };
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  assert.deepEqual(await pre111kApi.confirm('devnet', wallet, hash), response);
  response = { status: 'confirmed', confirmations: 3, transactionHash: hash, reservationNonce: 2 };
  assert.deepEqual(await pre111kApi.confirm('devnet', wallet, hash), response);
  for (const invalid of [
    { status: 'confirmed', confirmations: 2, transactionHash: hash, reservationNonce: 2 },
    { status: 'confirmed', confirmations: 3, transactionHash: hash, reservationNonce: null },
    { status: 'confirmed', confirmations: 3, transactionHash: hash, reservationNonce: 19 },
    { status: 'confirmed', confirmations: 3, transactionHash: `0x${'bb'.repeat(32)}`, reservationNonce: 2 },
  ]) {
    response = invalid;
    await assert.rejects(pre111kApi.confirm('devnet', wallet, hash));
  }
});
