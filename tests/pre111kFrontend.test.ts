import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePre111kReservation, resolvePre111kConfig, type Pre111kNetwork, type Pre111kPrepareResponse, type Pre111kStatus } from '../shared/ethereum/pre111k.ts';
import { checkedPre111kReservation, pre111kApi } from '../src/ethereum/pre111kApi.ts';
import { EthereumApiError } from '../src/ethereum/api.ts';

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

test('access verification posts only the code with CSRF and no-cache request conventions', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /\/ethereum\/pre111k\/access$/);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.cache, 'no-store');
    assert.equal(new Headers(options?.headers).get('X-Mons-CSRF'), '1');
    assert.deepEqual(JSON.parse(String(options?.body)), { code: 'TESTPASS' });
    return Response.json({ ok: true });
  });
  assert.deepEqual(await pre111kApi.verifyAccess('TESTPASS'), { ok: true });
});

test('access verification rejects malformed success responses', async t => {
  let response: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  for (const invalid of [{}, { ok: false }, { ok: 'true' }, null, []]) {
    response = invalid;
    await assert.rejects(pre111kApi.verifyAccess('TESTPASS'), /invalid response/i);
  }
});

test('access rejection and service outages retain distinct structured API errors', async t => {
  let status = 401;
  let code = 'unauthenticated';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: { code, message: 'Access unavailable.' } }, { status }));
  for (const expected of [{ status: 401, code: 'unauthenticated' }, { status: 503, code: 'unavailable' }]) {
    ({ status, code } = expected);
    await assert.rejects(pre111kApi.verifyAccess('TESTPASS'), error =>
      error instanceof EthereumApiError && error.status === status && error.code === code && error.message === 'Access unavailable.');
  }
});

test('each reservation preparation includes the saved code alongside its network and wallet', async t => {
  let expectedNetwork: Pre111kNetwork = 'mainnet';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /\/ethereum\/pre111k\/prepare$/);
    assert.deepEqual(JSON.parse(String(options?.body)), { network: expectedNetwork, wallet, code: 'TESTPASS' });
    return Response.json(prepared(expectedNetwork));
  });
  for (const network of ['mainnet', 'devnet'] as const) {
    expectedNetwork = network;
    const result = await pre111kApi.prepare(network, wallet, 'TESTPASS');
    assert.equal(result.network, network);
    assert.equal(result.wallet, wallet);
  }
});
