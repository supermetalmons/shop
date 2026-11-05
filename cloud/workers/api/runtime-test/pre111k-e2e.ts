import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress } from '../../../../shared/ethereum/crypto.ts';
import { PRE111K_API_PATHS, PRE111K_MAX_RELICS, PRE111K_TREASURY, type Pre111kPrepareResponse, type Pre111kStatus } from '../../../../shared/ethereum/pre111k.ts';
import { handlePre111kRequest, type Pre111kEnvironment } from '../src/pre111k.ts';

const root = resolve(import.meta.dirname, '../../../..');
const project = resolve(root, 'onchain/ethereum');
const build = spawnSync('forge', ['build', '--offline'], { cwd: project, stdio: 'inherit' });
if (build.status !== 0) throw new Error('Contract compilation failed');
const port = await new Promise<number>((done, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate local port')); return; }
    server.close(error => error ? reject(error) : done(address.port));
  });
});
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '11155111', '--hardfork', 'prague', '--silent'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let anvilError = '';
anvil.stderr.on('data', data => { anvilError += String(data); });
anvil.on('error', error => { anvilError += error.message; });
const rpcUrl = `http://127.0.0.1:${port}`;
let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message || `RPC ${method} failed`);
  return body.result;
}
type Receipt = { status: string; contractAddress: string | null; blockNumber: string; transactionHash: string };
async function send(from: string, transaction: { data: string; to?: string; value?: string }): Promise<Receipt> {
  const gas = await rpc<string>('eth_estimateGas', [{ from, ...transaction }]);
  const hash = await rpc<string>('eth_sendTransaction', [{ from, ...transaction, gas }]);
  for (let i = 0; i < 100; i++) {
    const receipt = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) { assert.equal(receipt.status, '0x1'); return receipt; }
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Local transaction did not mine');
}

try {
  let connected = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('eth_chainId'); connected = true; break; } catch {}
    await new Promise(done => setTimeout(done, 25));
  }
  if (!connected) throw new Error(`Anvil did not start: ${anvilError}`);
  const [admin, wallet, other] = await rpc<string[]>('eth_accounts');
  const key = `0x${'44'.repeat(32)}`;
  const artifact = JSON.parse(await readFile(resolve(project, 'out/Pre111K.sol/Pre111K.json'), 'utf8')) as { bytecode: { object: string } };
  const initialPrice = '2300000000000000';
  const nextPrice = '1700000000000000';
  const deployment = await send(admin, { data: `0x${artifact.bytecode.object.replace(/^0x/, '')}${encodeAbi(
    ['address', 'address', 'address'], [admin, PRE111K_TREASURY, ethereumSignerAddress(key)]).slice(2)}` });
  assert.ok(deployment.contractAddress);
  const contractAddress = deployment.contractAddress.toLowerCase();
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: Pre111kEnvironment = {
    ALCHEMY_MI_NOTE_API_KEY: 'local-test', ETHEREUM_111K_RPC_URL: '', PUBLIC_SHOP_RATE_LIMITER: limiter,
    PREORDER_PREPARE_RATE_LIMITER: limiter, PREORDER_PREPARE_IP_RATE_LIMITER: limiter,
    ETHEREUM_PRE111K_ACCESS_CODES: '["TESTACCESS"]',
    ETHEREUM_PRE111K_MAINNET_CONTRACT_ADDRESS: '', ETHEREUM_PRE111K_MAINNET_DEPLOYMENT_BLOCK: '0', ETHEREUM_PRE111K_MAINNET_ENABLED: 'false',
    ETHEREUM_PRE111K_MAINNET_PRICE_WEI: '2300000000000000000', ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI: initialPrice,
    ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS: contractAddress, ETHEREUM_PRE111K_SEPOLIA_DEPLOYMENT_BLOCK: String(Number(deployment.blockNumber)),
    ETHEREUM_PRE111K_SEPOLIA_ENABLED: 'true', ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET: key,
  };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const request = new Request(`https://api.mons.shop${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await handlePre111kRequest(request, env, path.split('?')[0], {
      fetch: (_input, init) => fetch(rpcUrl, init),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value as T;
  }
  const status = (owner = wallet) => api<Pre111kStatus>(`${PRE111K_API_PATHS.status}?network=devnet&wallet=${owner}`);
  const prepare = (owner = wallet) => api<Pre111kPrepareResponse>(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: owner, code: 'TESTACCESS' });
  assert.deepEqual(await api(PRE111K_API_PATHS.access, { code: ' testaccess ' }), { ok: true });
  for (const code of [undefined, 'WRONGCODE']) {
    const rejected = await handlePre111kRequest(new Request(`https://api.mons.shop${PRE111K_API_PATHS.prepare}`, {
      method: 'POST', headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1',
        'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
      body: JSON.stringify({ network: 'devnet', wallet, code }),
    }), env, PRE111K_API_PATHS.prepare, { fetch: async () => { throw new Error('Invalid codes must not reach the chain'); } });
    assert.equal(rejected.status, 401);
  }
  const initial = await status();
  assert.equal(initial.totalReserved, 0);
  assert.equal(initial.remainingRelics, 17);
  assert.equal(initial.reservedRelics, 0);
  assert.equal(initial.config.enabled, true);
  const quote = await prepare();
  assert.equal(BigInt(quote.transaction.value), BigInt(initialPrice));
  await assert.rejects(send(other, quote.transaction), /revert/);
  env.ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI = nextPrice;
  assert.equal((await status()).config.priceWei, nextPrice);
  for (const value of [0n, BigInt(nextPrice), BigInt(initialPrice) + 1n]) {
    await assert.rejects(send(wallet, { ...quote.transaction, value: `0x${value.toString(16)}` }), /revert/);
  }
  const receipt = await send(wallet, quote.transaction);
  const pending = await api<{ status: string }>(PRE111K_API_PATHS.confirm,
    { network: 'devnet', wallet, transactionHash: receipt.transactionHash });
  assert.equal(pending.status, 'pending');
  await rpc('anvil_mine', ['0x2']);
  const confirmed = await api<{ status: string; reservationNonce: number }>(PRE111K_API_PATHS.confirm,
    { network: 'devnet', wallet, transactionHash: receipt.transactionHash });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.reservationNonce, 0);
  assert.equal((await status()).reservedRelics, 1);
  await assert.rejects(send(wallet, quote.transaction), /revert/);
  for (let i = 1; i < PRE111K_MAX_RELICS - 1; i++) {
    const next = await prepare();
    assert.equal(next.nonce, i);
    assert.equal(BigInt(next.transaction.value), BigInt(nextPrice));
    await send(wallet, next.transaction);
  }
  const [last, competitor] = await Promise.all([prepare(), prepare(other)]);
  await send(wallet, last.transaction);
  await assert.rejects(send(other, competitor.transaction), /revert/);
  const soldOut = await status();
  assert.equal(soldOut.totalReserved, PRE111K_MAX_RELICS);
  assert.equal(soldOut.reservedRelics, PRE111K_MAX_RELICS);
  assert.equal(soldOut.remainingRelics, 0);
  assert.equal((await status(other)).reservedRelics, 0);
  const balanceBefore = BigInt(await rpc<string>('eth_getBalance', [PRE111K_TREASURY, 'latest']));
  await send(other, { to: contractAddress, data: encodeCall('withdraw()', [], []) });
  assert.equal(BigInt(await rpc<string>('eth_getBalance', [contractAddress, 'latest'])), 0n);
  const proceeds = BigInt(initialPrice) + BigInt(nextPrice) * BigInt(PRE111K_MAX_RELICS - 1);
  assert.equal(BigInt(await rpc<string>('eth_getBalance', [PRE111K_TREASURY, 'latest'])) - balanceBefore, proceeds);
  assert.equal((await status()).reservedRelics, PRE111K_MAX_RELICS);
  console.log('pre111k E2E passed: backend repricing, tampered-value rejection, confirmation, replay rejection, 17-slot race, and public withdrawal');
} finally {
  anvil.kill('SIGTERM');
}
